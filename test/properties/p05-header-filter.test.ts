// Feature: poc, Property 5: 转发请求头过滤
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { HOP_HEADERS } from '@dsh-poc/envelope'
import { fromDshHeaders, toDshHeaders } from '@dsh-poc/session-identity'
import { RUNS, arbHeaders } from '../arbitraries/index.js'

const sensitive = fc.record({
  authorization: fc.constant('Bearer abc.def.ghi'),
  cookie: fc.constant('dsh_token=secret'),
  origin: fc.constant('https://example.com'),
  'sec-fetch-mode': fc.constant('cors'),
  'x-amz-date': fc.constant('20260101T000000Z'),
  'x-amzn-bedrock-agentcore-runtime-session-id': fc.constant('dsh-user-x'),
  connection: fc.constant('keep-alive'),
  host: fc.constant('example.com'),
  'content-length': fc.constant('3'),
})
const dropped = (k: string) => HOP_HEADERS.has(k) || ['authorization', 'cookie', 'origin'].includes(k) || k.startsWith('sec-fetch-') || k.startsWith('x-amz')

describe('Property 5: 转发请求头过滤', () => {
  it('toDshHeaders：去掉身份与逐跳头，其余不变，Host 与 cookie 换成 DSH 的', () => {
    fc.assert(fc.property(arbHeaders, sensitive, fc.option(fc.constant('dsh-auth-x=1'), { nil: null }), (h, s, cookie) => {
      const input = { ...h, ...s }
      const out = toDshHeaders(input, '127.0.0.1:3080', cookie)
      expect(out.host).toBe('127.0.0.1:3080')
      if (cookie) expect(out.cookie).toBe(cookie)
      else expect(out.cookie).toBeUndefined()
      expect(out.authorization).toBeUndefined()
      for (const k of Object.keys(out)) if (k !== 'host' && k !== 'cookie') expect(dropped(k)).toBe(false)
      for (const [k, v] of Object.entries(input)) if (!dropped(k)) expect(out[k]).toEqual(v)
    }), { numRuns: RUNS.default })
  })

  it('fromDshHeaders：去掉逐跳头与 dsh-auth-* cookie，其余不变', () => {
    fc.assert(fc.property(arbHeaders, fc.array(fc.oneof(fc.constant('dsh-auth-abc=1; Path=/'), fc.constant('pref=dark; Path=/')), { maxLength: 4 }), (h, cookies) => {
      const input = { ...h, connection: 'close', 'transfer-encoding': 'chunked', ...(cookies.length ? { 'set-cookie': cookies } : {}) }
      const out = fromDshHeaders(input)
      for (const k of Object.keys(out)) expect(HOP_HEADERS.has(k)).toBe(false)
      const kept = cookies.filter((c) => !c.startsWith('dsh-auth-'))
      if (kept.length) expect(out['set-cookie']).toEqual(kept)
      else expect(out['set-cookie']).toBeUndefined()
      for (const [k, v] of Object.entries(h)) if (!HOP_HEADERS.has(k) && k !== 'set-cookie') expect(out[k]).toEqual(v)
    }), { numRuns: RUNS.default })
  })
})

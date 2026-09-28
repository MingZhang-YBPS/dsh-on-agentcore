// Feature: poc, Property 3: 会话归属判定
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { sessionOwnerRejection } from '@dsh-poc/session-identity'
import { RUNS, arbUuid } from '../arbitraries/index.js'

const b64u = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const jwt = (payload: unknown, sig = 'c2ln') => `${b64u({ alg: 'RS256', kid: 'k' })}.${b64u(payload)}.${sig}`
const hdrs = (auth: string | undefined, sid: string | undefined) => ({ authorization: auth, 'x-amzn-bedrock-agentcore-runtime-session-id': sid })

describe('Property 3: 会话归属判定', () => {
  it('Bearer 令牌的 sub 与会话 ID 一致时放行', () => {
    fc.assert(fc.property(arbUuid, fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 5 }), (sub, extra) => {
      expect(sessionOwnerRejection(hdrs(`Bearer ${jwt({ ...extra, sub })}`, `dsh-user-${sub}`))).toBeNull()
    }), { numRuns: RUNS.default })
  })

  it('sub 不一致、缺头、形态错误、payload 不可解析时全部拒绝', () => {
    const bad = fc.oneof(
      // 他人的会话 ID
      fc.tuple(arbUuid, arbUuid).filter(([a, b]) => a !== b).map(([a, b]) => hdrs(`Bearer ${jwt({ sub: a })}`, `dsh-user-${b}`)),
      // 缺 Authorization 或缺会话 ID
      arbUuid.map((s) => hdrs(undefined, `dsh-user-${s}`)),
      arbUuid.map((s) => hdrs(`Bearer ${jwt({ sub: s })}`, undefined)),
      // 不是 Bearer / 不是三段 / payload 不是 JSON 对象 / 没有 sub / sub 不是 UUID
      arbUuid.map((s) => hdrs(`Basic ${jwt({ sub: s })}`, `dsh-user-${s}`)),
      fc.tuple(arbUuid, fc.string({ maxLength: 40 })).map(([s, t]) => hdrs(`Bearer ${t.replace(/\./g, '')}`, `dsh-user-${s}`)),
      arbUuid.map((s) => hdrs(`Bearer ${b64u('h')}.${b64u('not json')}.sig`, `dsh-user-${s}`)),
      arbUuid.map((s) => hdrs(`Bearer ${jwt([s])}`, `dsh-user-${s}`)),
      arbUuid.map((s) => hdrs(`Bearer ${jwt({ username: s })}`, `dsh-user-${s}`)),
      fc.string({ minLength: 1, maxLength: 20 }).map((s) => hdrs(`Bearer ${jwt({ sub: s })}`, `dsh-user-${s}`)),
      // 会话 ID 大小写或前缀不同
      arbUuid.map((s) => hdrs(`Bearer ${jwt({ sub: s })}`, `DSH-USER-${s}`)),
      arbUuid.map((s) => hdrs(`Bearer ${jwt({ sub: s })}`, s)),
    )
    fc.assert(fc.property(bad, (h) => { expect(sessionOwnerRejection(h)).not.toBeNull() }), { numRuns: RUNS.default * 3 })
  })
})

// Feature: poc, Property 2: 原始查询串重写保真
// default-rewrite（CloudFront Function）+ 隧道 Lambda 的还原逻辑组合后：
//   - 原始查询串含以「?」开头的键时，还原出的查询串包含全部原始键值对（多值保持各自顺序），且以「?」开头的键排在最前；
//   - 不含以「?」开头的键时，请求原样不变。
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { loadFunction, request, type CfRequest, type CfValue } from '../../services/edge/test/load.js'
import { RUNS } from '../arbitraries/index.js'

const fn = loadFunction('default-rewrite.js')

// Lambda 一侧的还原（与 services/tunnel/src/handler.ts 相同）
const restore = (r: CfRequest) => { const h = r.headers['x-dsh-raw-query']?.value; return h ? decodeURIComponent(h) : null }

const key = fc.oneof(
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,8}$/),
  fc.array(fc.stringMatching(/^@[a-z]{1,6}\/[a-z]{1,6}\/client\.js$/), { minLength: 1, maxLength: 4 }).map((xs) => `?${xs.join(',')}`),
)
const value = fc.oneof(fc.constant(''), fc.stringMatching(/^[a-zA-Z0-9%._~-]{1,12}$/))
// 键 → 值列表；对象的键顺序随机（CloudFront 解析出的顺序与 URL 不一致）
const arbQuery = fc.dictionary(key, fc.array(value, { minLength: 1, maxLength: 3 }), { minKeys: 0, maxKeys: 6 })

const toCf = (q: Record<string, string[]>): Record<string, CfValue> =>
  Object.fromEntries(Object.entries(q).map(([k, vs]) => [k, vs.length === 1 ? { value: vs[0] as string } : { value: vs[0] as string, multiValue: vs.map((v) => ({ value: v })) }]))

function pairs(raw: string): [string, string][] {
  return raw.split('&').map((p) => { const i = p.indexOf('='); return (i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]) as [string, string] })
}

describe('Property 2: 原始查询串重写保真', () => {
  it('含「?」键：还原后键值对完整、多值顺序不变、「?」键在最前；否则请求不变', () => {
    fc.assert(fc.property(arbQuery, fc.boolean(), (q, withCookie) => {
      const ev = request({ uri: '/plugins/', querystring: toCf(q), cookies: withCookie ? { dsh_token: { value: 't' } } : {} })
      const r = fn(ev) as CfRequest & { statusCode?: number }
      if (!withCookie) { expect(r.statusCode).toBe(401); return }
      const hasQ = Object.keys(q).some((k) => k.startsWith('?'))
      if (!hasQ) { expect(r).toEqual(ev.request); return }
      const raw = restore(r)
      expect(raw).not.toBeNull()
      expect(r.querystring).toEqual({})
      const got = pairs(raw as string)
      expect(got[0]?.[0].startsWith('?')).toBe(true)
      const firstNonQ = got.findIndex(([k]) => !k.startsWith('?'))
      if (firstNonQ >= 0) expect(got.slice(firstNonQ).every(([k]) => !k.startsWith('?'))).toBe(true)
      for (const [k, vs] of Object.entries(q)) expect(got.filter(([gk]) => gk === k).map(([, v]) => v)).toEqual(vs)
      expect(got).toHaveLength(Object.values(q).reduce((n, vs) => n + vs.length, 0))
    }), { numRuns: RUNS.roundTrip })
  })

  it('非 /plugins/ 路径不要求 cookie（由 Lambda 处理登录跳转）', () => {
    const ev = request({ uri: '/', querystring: {} })
    expect(fn(ev)).toEqual(ev.request)
  })
})

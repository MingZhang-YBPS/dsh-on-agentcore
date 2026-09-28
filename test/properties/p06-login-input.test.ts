// Feature: poc, Property 6: 登录输入校验与统一失败
// 本文件覆盖纯函数部分（输入校验）；「所有失败情形返回逐字节相同的响应且不下发 cookie」在隧道 Lambda 的
// 属性测试 p06-login-uniform.test.ts 中验证。
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MAX_PASSWORD_CODE_POINTS, MAX_USERNAME_CODE_POINTS, validateLoginInput } from '@dsh-poc/auth-throttle'
import { RUNS } from '../arbitraries/index.js'

const cps = (s: string) => [...s].length

describe('Property 6（输入校验）', () => {
  it('合法当且仅当两者非空且按码位计数不超过上限', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 90 }), fc.string({ unit: 'grapheme', maxLength: 160 }), (u, p) => {
      const expected = u.length > 0 && p.length > 0 && cps(u) <= MAX_USERNAME_CODE_POINTS && cps(p) <= MAX_PASSWORD_CODE_POINTS
      expect(validateLoginInput(u, p)).toBe(expected)
    }), { numRuns: RUNS.default * 3 })
  })

  it('边界：64/65 码位用户名，128/129 码位口令（含多码元字符）', () => {
    expect(validateLoginInput('😀'.repeat(64), 'p')).toBe(true)
    expect(validateLoginInput('😀'.repeat(65), 'p')).toBe(false)
    expect(validateLoginInput('u', '字'.repeat(128))).toBe(true)
    expect(validateLoginInput('u', '字'.repeat(129))).toBe(false)
  })
})

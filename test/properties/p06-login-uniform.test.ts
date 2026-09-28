// Feature: poc, Property 6: 登录输入校验与统一失败
// 隧道 Lambda 部分：所有失败情形（输入非法、锁定中、凭证错误、用户不存在）返回逐字节相同的响应，且不下发 cookie；
// 输入非法时不调用 Cognito。
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { validateLoginInput } from '@dsh-poc/auth-throttle'
import { handle } from '@dsh-poc/tunnel/handler'
import { capture, event, form, makeDeps } from '../../services/tunnel/test/fakes.js'
import { RUNS } from '../arbitraries/index.js'

async function loginOnce(d: ReturnType<typeof makeDeps>, username: string, password: string) {
  const c = capture()
  await handle(event({ rawPath: '/auth/login', method: 'POST', body: form({ username, password }) }), c.open, d)
  return c.res
}

describe('Property 6: 登录统一失败', () => {
  it('任意失败尝试的响应都与参考失败响应逐字节相同，且不含 Set-Cookie', async () => {
    const d0 = makeDeps()
    const reference = await loginOnce(d0, 'nobody', 'x')
    expect(reference.status).toBe(401)
    await fc.assert(fc.asyncProperty(
      fc.oneof(fc.string({ unit: 'grapheme', maxLength: 80 }), fc.constantFrom('alice', 'ALICE', 'nobody', '')),
      fc.string({ unit: 'grapheme', maxLength: 140 }).filter((p) => p !== 'Correct-Horse-1'),
      fc.boolean(),
      async (username, password, lockFirst) => {
        const d = makeDeps()
        if (lockFirst) for (let i = 0; i < 5; i++) await loginOnce(d, username || 'alice', 'wrong')
        const before = d.auth.logins
        const r = await loginOnce(d, username, password)
        expect(r.status).toBe(reference.status)
        expect(r.headers).toEqual(reference.headers)
        expect(Buffer.compare(r.body, reference.body)).toBe(0)
        expect(r.cookies).toEqual([])
        if (!validateLoginInput(username, password)) expect(d.auth.logins).toBe(before)
      },
    ), { numRuns: RUNS.default })
  })

  it('锁定中即使口令正确也返回同一失败响应', async () => {
    const d = makeDeps()
    for (let i = 0; i < 5; i++) await loginOnce(d, 'alice', 'wrong')
    const reference = await loginOnce(makeDeps(), 'nobody', 'x')
    const r = await loginOnce(d, 'alice', 'Correct-Horse-1')
    expect(Buffer.compare(r.body, reference.body)).toBe(0)
    expect(r.cookies).toEqual([])
  })
})

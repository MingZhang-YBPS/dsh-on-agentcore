// Feature: poc, Property 8: 日志不含敏感值
// 覆盖共享日志器（适配器与隧道 Lambda 都使用 @dsh-poc/log），以及隧道 Lambda 在登录、续期、转发路径上实际输出的日志。
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createLogger } from '@dsh-poc/log'
import { handle } from '@dsh-poc/tunnel/handler'
import { accessToken, capture, event, form, makeDeps } from '../../services/tunnel/test/fakes.js'
import { RUNS } from '../arbitraries/index.js'

const secretish = fc.stringMatching(/^[A-Za-z0-9_-]{12,40}$/)
const leaks = (lines: string[], secrets: string[]) => secrets.filter((s) => s.length >= 8 && lines.some((l) => l.includes(s)))

describe('Property 8: 日志不含敏感值', () => {
  it('日志器：敏感键被丢弃，值中的 JWT / Bearer / cookie / 签名被替换', () => {
    fc.assert(fc.property(secretish, secretish, secretish, fc.string({ maxLength: 20 }), (a, b, c, other) => {
      const jwt = `eyJ${a}.eyJ${b}.${c}`
      const lines: string[] = []
      const log = createLogger({ write: (l) => lines.push(l) })
      log('info', `request with Bearer ${jwt}`, {
        password: a, accessToken: jwt, headers: { authorization: `Bearer ${jwt}`, cookie: `dsh_token=${jwt}` },
        note: `cookie dsh_token=${b}; dsh_refresh=${c}`, url: `/x?token=${a}&X-Amz-Signature=${b}`, nested: [{ refreshToken: c }], other,
      })
      expect(leaks(lines, [a, b, c, jwt])).toEqual([])
      expect(JSON.parse(lines[0] as string).other).toBe(other)
    }), { numRuns: RUNS.default })
  })

  it('隧道 Lambda：登录、续期、转发、登出路径的日志中不出现口令、令牌与 cookie 值', async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9!@#$%^&*]{8,30}$/), async (password) => {
      const d = makeDeps()
      d.auth.users.set('alice', password)
      const lines: string[] = []
      const log = createLogger({ write: (l) => lines.push(l) })
      const deps = { ...d, log }
      const tokBad = accessToken(Math.floor(d.clock.now() / 1000) + 60)
      for (const ev of [
        event({ rawPath: '/auth/login', method: 'POST', body: form({ username: 'alice', password: `${password}x` }) }),
        event({ rawPath: '/auth/login', method: 'POST', body: form({ username: 'alice', password }) }),
        event({ rawPath: '/api/session/prompt', method: 'POST', cookies: [`dsh_token=${tokBad}`, 'dsh_refresh=refresh-token-value'], body: 'hello' }),
        event({ rawPath: '/auth/logout', cookies: [`dsh_token=${tokBad}`] }),
      ]) { const c = capture(); await handle(ev, c.open, deps) }
      expect(lines.length).toBeGreaterThan(0)
      expect(leaks(lines, [password, tokBad, 'refresh-token-value', 'origin-secret'])).toEqual([])
    }), { numRuns: 30 })
  })
})

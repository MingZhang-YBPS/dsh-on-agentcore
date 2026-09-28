import { describe, expect, it } from 'vitest'
import { handle } from '../src/handler.js'
import { SUB, accessToken, capture, event, form, makeDeps } from './fakes.js'

const nowSec = (d: { clock: { now(): number } }) => Math.floor(d.clock.now() / 1000)

describe('隧道 Lambda 路由', () => {
  it('源站密钥不匹配 → 403（绕过 CloudFront 直连）', async () => {
    const d = makeDeps()
    for (const headers of [{}, { 'x-origin-verify': 'wrong' }]) {
      const { open, res } = capture()
      await handle(event({ headers }), open, d)
      expect(res.status).toBe(403)
    }
    expect(d.runtime.calls).toHaveLength(0)
  })

  it('未登录：页面导航 303 到登录页，API 401，登录页 200', async () => {
    const d = makeDeps()
    let c = capture(); await handle(event({ rawPath: '/' }), c.open, d); expect(c.res.status).toBe(303); expect(c.res.headers.location).toBe('/auth/login')
    c = capture(); await handle(event({ rawPath: '/api/session/list', method: 'POST' }), c.open, d); expect(c.res.status).toBe(401)
    c = capture(); await handle(event({ rawPath: '/auth/login' }), c.open, d); expect(c.res.status).toBe(200); expect(c.res.body.toString()).toContain('<form method="post"')
  })

  it('登录成功：303 / 并下发 HttpOnly 的访问令牌与刷新令牌 cookie', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/auth/login', method: 'POST', body: form({ username: 'alice', password: 'Correct-Horse-1' }) }), open, d)
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/')
    expect(res.cookies.find((c) => c.startsWith('dsh_token='))).toMatch(/HttpOnly; Secure; SameSite=Lax/)
    expect(res.cookies.find((c) => c.startsWith('dsh_refresh='))).toMatch(/Max-Age=86400; HttpOnly; Secure; SameSite=Strict/)
  })

  it('5 分钟内第 5 次失败起锁定：锁定期内正确口令也失败且不调用 Cognito；15 分钟后恢复', async () => {
    const d = makeDeps()
    const attempt = async (password: string) => { const c = capture(); await handle(event({ rawPath: '/auth/login', method: 'POST', body: form({ username: 'Alice', password }) }), c.open, d); return c.res }
    for (let i = 0; i < 5; i++) { expect((await attempt('wrong')).status).toBe(401); d.clock.t += 30_000 }
    const before = d.auth.logins
    expect((await attempt('Correct-Horse-1')).status).toBe(401)
    expect(d.auth.logins).toBe(before)
    d.clock.t += 15 * 60_000
    expect((await attempt('Correct-Horse-1')).status).toBe(303)
  })

  it('转发：会话 ID 由 sub 派生，去掉身份与 CloudFront 头，还原 x-dsh-raw-query，透传状态、响应头与 cookie', async () => {
    const d = makeDeps()
    const tok = accessToken(nowSec(d) + 3600)
    const { open, res } = capture()
    await handle(event({
      rawPath: '/plugins/', method: 'GET', cookies: [`dsh_token=${tok}`],
      headers: { 'x-origin-verify': 'origin-secret', 'x-dsh-raw-query': encodeURIComponent('?@a/client.js,@b/client.js&rev=abc'), 'cloudfront-viewer-country': 'US', 'x-forwarded-for': '1.2.3.4', 'x-amz-cf-id': 'x', accept: 'text/javascript', 'x-amzn-bedrock-agentcore-runtime-session-id': 'dsh-user-evil' },
    }), open, d)
    const call = d.runtime.calls[0]
    expect(call?.sessionId).toBe(`dsh-user-${SUB}`)
    expect(call?.token).toBe(tok)
    expect(call?.payload.path).toBe('/plugins/??@a/client.js,@b/client.js&rev=abc')
    expect(call?.payload.headers).toEqual({ accept: 'text/javascript' })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('hello from dsh')
    // /plugins/* 可被 CloudFront 共享缓存：不透传 Set-Cookie
    expect(res.cookies).toEqual([])
  })

  it('非共享缓存路径透传 DSH 的 Set-Cookie', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/api/session/list', method: 'POST', cookies: [`dsh_token=${accessToken(nowSec(d) + 3600)}`] }), open, d)
    expect(res.status).toBe(200)
    expect(res.cookies).toEqual(['pref=1; Path=/'])
  })

  it('/plugins/* 不做滑动续期、不下发任何 cookie（避免令牌进入共享缓存）', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/plugins/@a/client.js', cookies: [`dsh_token=${accessToken(nowSec(d) + 60)}`, 'dsh_refresh=refresh-token-value'] }), open, d)
    expect(d.auth.refreshes).toBe(0)
    expect(res.status).toBe(200)
    expect(res.cookies).toEqual([])
  })

  it('访问令牌快过期时用刷新令牌续期，并在本次响应中更新 cookie', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/api/session/prompt', method: 'POST', cookies: [`dsh_token=${accessToken(nowSec(d) + 60)}`, 'dsh_refresh=refresh-token-value'] }), open, d)
    expect(d.auth.refreshes).toBe(1)
    expect(res.status).toBe(200)
    const renewed = res.cookies.find((c) => c.startsWith('dsh_token='))
    expect(renewed).toBeDefined()
    expect(d.runtime.calls[0]?.token).toBe(renewed?.split(';')[0]?.slice('dsh_token='.length))
  })

  it('刷新失败（已登出）时仍用原令牌转发，AgentCore 401 → 页面导航清 cookie 跳登录页', async () => {
    const d = makeDeps()
    d.auth.refreshValid = false
    d.runtime.statuses = [401]
    const { open, res } = capture()
    await handle(event({ rawPath: '/', cookies: [`dsh_token=${accessToken(nowSec(d) - 10)}`, 'dsh_refresh=revoked'] }), open, d)
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/auth/login')
    expect(res.cookies.some((c) => c.startsWith('dsh_token=;') && c.includes('Max-Age=0'))).toBe(true)
  })

  it('AgentCore 409 退避重试；其他非 200 → 502', async () => {
    const d = makeDeps()
    d.runtime.statuses = [409, 409, 200]
    let c = capture()
    await handle(event({ rawPath: '/x', cookies: [`dsh_token=${accessToken(nowSec(d) + 3600)}`] }), c.open, d)
    expect(c.res.status).toBe(200)
    expect(d.runtime.calls).toHaveLength(3)
    d.runtime.statuses = [424]
    c = capture()
    await handle(event({ rawPath: '/x', cookies: [`dsh_token=${accessToken(nowSec(d) + 3600)}`] }), c.open, d)
    expect(c.res.status).toBe(502)
  })

  it('登出：GlobalSignOut 并清除两个 cookie', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/auth/logout', cookies: [`dsh_token=${accessToken(nowSec(d) + 3600)}`] }), open, d)
    expect(d.auth.signedOut).toEqual(['alice'])
    expect(res.status).toBe(303)
    expect(res.cookies).toHaveLength(2)
    expect(res.cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it('sub 不是 UUID 的令牌 → 401 并清 cookie，不调用 AgentCore', async () => {
    const d = makeDeps()
    const { open, res } = capture()
    await handle(event({ rawPath: '/x', cookies: [`dsh_token=${accessToken(nowSec(d) + 3600, '../../etc')}`] }), open, d)
    expect(res.status).toBe(401)
    expect(d.runtime.calls).toHaveLength(0)
  })
})

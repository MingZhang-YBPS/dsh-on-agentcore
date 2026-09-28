// 隧道 Lambda 的路由与业务逻辑（不直接依赖 AWS SDK，见 ports.ts）。
//   任意路径，X-Origin-Verify 不匹配   → 403（绕过 CloudFront 直连 Function URL）
//   GET  /auth/login                   → 登录页
//   POST /auth/login                   → 输入校验 → 节流 → Cognito → 303 /（下发 dsh_token 与 dsh_refresh）；所有失败返回同一个 401 登录页
//   GET  /auth/logout                  → GlobalSignOut → 清除 cookie → 303 /auth/login
//   其他路径                           → 必要时用刷新令牌续期 → 封包调用 InvokeAgentRuntime → 流式透传
// 会话 ID 只由访问令牌的 sub 派生（dsh-user-<sub>），浏览器无法指定。

import { createHash, timingSafeEqual } from 'node:crypto'
import { DEFAULT_POLICY, EMPTY_STATE, UNIFORM_FAILURE_MESSAGE, UNIFORM_FAILURE_STATUS, isLocked, recordFailure, throttleKey, validateLoginInput, type ThrottlePolicy } from '@dsh-poc/auth-throttle'
import { decodeResponseStream, encodeRequest, type Headers } from '@dsh-poc/envelope'
import { jwtPayload, sessionIdOf } from '@dsh-poc/session-identity'
import type { Logger } from '@dsh-poc/log'
import { ACCESS_COOKIE, CLEAR_COOKIES, REFRESH_COOKIE, accessCookie, parseCookies, refreshCookie } from './cookies.js'
import { loginPage } from './login-page.js'
import { AuthFailed, type AuthPort, type Clock, type OpenResponse, type RuntimePort, type ThrottleStore } from './ports.js'

/** Lambda Function URL（payload 2.0）事件中本处理器用到的字段 */
export interface FunctionUrlEvent {
  rawPath: string
  rawQueryString?: string
  headers?: Record<string, string | undefined>
  cookies?: string[]
  body?: string
  isBase64Encoded?: boolean
  requestContext: { http: { method: string }; requestId?: string }
}

export interface TunnelConfig {
  originSecret: string
  refreshTokenMaxAgeSeconds: number
  refreshSkewSeconds: number
  throttlePolicy?: ThrottlePolicy
}

export interface Deps { cfg: TunnelConfig; auth: AuthPort; throttle: ThrottleStore; runtime: RuntimePort; clock: Clock; log: Logger }

// 发往 AgentCore 前从浏览器请求头中去掉的头：由 CloudFront / Function URL 添加的、以及本处理器自己使用的
const DROP_HEADER = /^(x-amz|x-forwarded-|cloudfront-|x-origin-verify$|x-dsh-raw-query$|connection$|keep-alive$|transfer-encoding$|upgrade$|te$|trailer$|content-length$|host$|cookie$|authorization$)/
const HOP_OUT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'host'])
const RETRY_409_MS = [200, 400, 800]

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function reply(open: OpenResponse, status: number, headers: Record<string, string>, body = '', cookies: readonly string[] = []): void {
  const w = open(status, headers, cookies)
  // Function URL 响应流：from() 之后至少 write 一次（空响应体也写空串），否则状态码与响应头发不出去
  w.write(body)
  w.end()
}

const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
const text = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

/** 所有登录失败情形返回完全相同的响应：同一状态码、同一响应体、不含 Set-Cookie */
export function uniformLoginFailure(open: OpenResponse): void {
  reply(open, UNIFORM_FAILURE_STATUS, html, loginPage(UNIFORM_FAILURE_MESSAGE))
}

function formBody(ev: FunctionUrlEvent): URLSearchParams {
  const raw = ev.isBase64Encoded ? Buffer.from(ev.body ?? '', 'base64').toString('utf8') : (ev.body ?? '')
  return new URLSearchParams(raw)
}

async function login(ev: FunctionUrlEvent, open: OpenResponse, d: Deps): Promise<void> {
  const form = formBody(ev)
  const username = form.get('username') ?? ''
  const password = form.get('password') ?? ''
  if (!validateLoginInput(username, password)) { d.log('info', 'login rejected', { reason: 'invalid input' }); uniformLoginFailure(open); return }
  const policy = d.cfg.throttlePolicy ?? DEFAULT_POLICY
  const key = `THROTTLE#${createHash('sha256').update(throttleKey(username)).digest('hex')}`
  const now = d.clock.now()
  const cur = await d.throttle.get(key)
  if (isLocked(cur.state, now)) { d.log('info', 'login rejected', { reason: 'locked' }); uniformLoginFailure(open); return }
  try {
    const t = await d.auth.login(username, password)
    reply(open, 303, { location: '/', 'cache-control': 'no-store' }, '', [accessCookie(t.accessToken, t.expiresIn), ...(t.refreshToken ? [refreshCookie(t.refreshToken, d.cfg.refreshTokenMaxAgeSeconds)] : [])])
    d.log('info', 'login ok', {})
  } catch (e) {
    if (!(e instanceof AuthFailed) && (e as Error).name !== 'AuthFailed') throw e
    // 乐观并发：版本冲突时重读重算，最多 3 次
    let s = cur
    for (let i = 0; i < 3; i++) {
      const next = recordFailure(s.state, now, policy)
      const ttl = Math.ceil((now + policy.windowMs + policy.lockMs) / 1000) + 86_400
      if (await d.throttle.put(key, next, s.version, ttl)) break
      s = await d.throttle.get(key)
    }
    d.log('info', 'login rejected', { reason: 'bad credentials' })
    uniformLoginFailure(open)
  }
}

async function logout(ev: FunctionUrlEvent, open: OpenResponse, d: Deps): Promise<void> {
  const cookies = parseCookies(ev.cookies)
  const tok = cookies.get(ACCESS_COOKIE)
  const username = tok ? jwtPayload(tok)?.username : undefined
  if (typeof username === 'string') await d.auth.globalSignOut(username).catch((e: Error) => d.log('warn', 'global sign-out failed', { error: e.message }))
  reply(open, 303, { location: '/auth/login', 'cache-control': 'no-store' }, '', CLEAR_COOKIES)
}

const isPageNavigation = (ev: FunctionUrlEvent) => ev.requestContext.http.method === 'GET' && (ev.rawPath === '/' || ev.rawPath === '/index.html')
// /plugins/* 在 CloudFront 上可被缓存、并由所有用户共享：这类响应绝不能带 Set-Cookie（否则会把某个用户的令牌缓存给别人），
// 因此不在这里做滑动续期，也不透传 DSH 的 Set-Cookie（CloudFront 的响应头策略另外再删一次）
const isSharedCacheable = (ev: FunctionUrlEvent) => ev.rawPath.startsWith('/plugins/')

async function tunnel(ev: FunctionUrlEvent, open: OpenResponse, d: Deps): Promise<void> {
  const t0 = d.clock.now()
  const cookies = parseCookies(ev.cookies)
  let token = cookies.get(ACCESS_COOKIE)
  if (!token) {
    if (isPageNavigation(ev)) reply(open, 303, { location: '/auth/login', 'cache-control': 'no-store' })
    else reply(open, 401, text, 'login required')
    return
  }
  let payload = jwtPayload(token)
  const setCookies: string[] = []
  // 滑动续期：访问令牌已过期或快过期时，用刷新令牌换一个新的（Spike 09：过期后 DSH_Web 发消息会静默失败）
  const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : 0
  const shared = isSharedCacheable(ev)
  if (!shared && exp - d.clock.now() < d.cfg.refreshSkewSeconds * 1000) {
    const rt = cookies.get(REFRESH_COOKIE)
    const username = payload?.username
    if (rt && typeof username === 'string') {
      try {
        const t = await d.auth.refresh(rt, username)
        token = t.accessToken
        payload = jwtPayload(token)
        setCookies.push(accessCookie(token, t.expiresIn))
        d.log('info', 'token refreshed', {})
      } catch (e) {
        d.log('info', 'token refresh failed', { error: (e as Error).name })
      }
    }
  }
  let sessionId: string
  try { sessionId = sessionIdOf(String(payload?.sub ?? '')) } catch {
    reply(open, 401, text, 'bad token', CLEAR_COOKIES)
    return
  }
  const headers: Headers = {}
  for (const [k, v] of Object.entries(ev.headers ?? {})) if (v !== undefined && !DROP_HEADER.test(k)) headers[k] = v
  // 以「?」开头的查询串（/plugins/??a,b&rev=）由 CloudFront Function 搬进 x-dsh-raw-query（Function URL 会拒绝这种查询串）
  const rawHeader = ev.headers?.['x-dsh-raw-query']
  const rawQuery = rawHeader ? decodeURIComponent(rawHeader) : (ev.rawQueryString ?? '')
  const body = ev.body ? (ev.isBase64Encoded ? Buffer.from(ev.body, 'base64') : Buffer.from(ev.body, 'utf8')) : Buffer.alloc(0)
  const env = encodeRequest({ method: ev.requestContext.http.method, path: ev.rawPath + (rawQuery ? `?${rawQuery}` : ''), headers, body })

  let r = await d.runtime.invoke(env, sessionId, token)
  for (const wait of RETRY_409_MS) {
    if (r.status !== 409) break
    await new Promise((res) => setTimeout(res, wait))
    r = await d.runtime.invoke(env, sessionId, token)
  }
  if (r.status === 401 || r.status === 403) {
    d.log('warn', 'agentcore rejected token', { status: r.status, path: ev.rawPath.slice(0, 120) })
    if (isPageNavigation(ev)) reply(open, 303, { location: '/auth/login', 'cache-control': 'no-store' }, '', CLEAR_COOKIES)
    else reply(open, r.status, text, (await r.text()).slice(0, 300), setCookies)
    return
  }
  if (r.status !== 200 || !r.body) {
    const detail = (await r.text()).slice(0, 300)
    d.log('error', 'agentcore error', { status: r.status, detail, path: ev.rawPath.slice(0, 120), sessionId })
    reply(open, 502, text, `agentcore ${r.status}`, setCookies)
    return
  }
  const { head, rest } = await decodeResponseStream(r.body)
  const outHeaders: Record<string, string> = {}
  const outCookies = [...setCookies]
  for (const [k, v] of Object.entries(head.headers)) {
    if (HOP_OUT.has(k)) continue
    if (k === 'set-cookie') { if (!shared) outCookies.push(...(Array.isArray(v) ? v : [v])); continue }
    outHeaders[k] = Array.isArray(v) ? v.join(', ') : v
  }
  const w = open(head.status, outHeaders, outCookies)
  w.write('')
  for await (const c of rest) w.write(c)
  w.end()
  d.log('info', 'tunnel', { method: ev.requestContext.http.method, path: ev.rawPath.slice(0, 120), status: head.status, ms: d.clock.now() - t0, sessionId })
}

export async function handle(ev: FunctionUrlEvent, open: OpenResponse, d: Deps): Promise<void> {
  if (!secretMatches(ev.headers?.['x-origin-verify'], d.cfg.originSecret)) { reply(open, 403, text, 'forbidden'); return }
  const method = ev.requestContext.http.method
  const path = ev.rawPath
  try {
    if (path === '/auth/login' && method === 'GET') { reply(open, 200, html, loginPage()); return }
    if (path === '/auth/login' && method === 'POST') { await login(ev, open, d); return }
    if (path === '/auth/logout') { await logout(ev, open, d); return }
    await tunnel(ev, open, d)
  } catch (e) {
    d.log('error', 'tunnel handler error', { path: path.slice(0, 120), error: (e as Error).message })
    try { reply(open, 502, text, 'tunnel error') } catch { /* 响应已经开始 */ }
  }
}

export { EMPTY_STATE }

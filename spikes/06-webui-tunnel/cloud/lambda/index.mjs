// 阶段 3 隧道 Lambda（Function URL，InvokeMode=RESPONSE_STREAM，AuthType=NONE，只接受携带 CloudFront 源头密钥的请求）。
//   GET  /auth/login   登录页（最小 HTML 表单）
//   POST /auth/login   AdminInitiateAuth（ADMIN_USER_PASSWORD_AUTH）→ Set-Cookie dsh_token=<access token>（HttpOnly; Secure; SameSite=Lax）
//   GET  /auth/logout  清除 cookie
//   其他路径          从 cookie 取访问令牌，派生 runtimeSessionId = dsh-user-<sub>，
//                     以 Bearer 令牌调用 AgentCore Runtime 的 /invocations（JWT 授权器验签），把封包响应流式写回
// WebSocket /api/remote.mux 不经过这里：CloudFront 直接转发到 AgentCore 的 /ws（见 cloud/cf-ws-function.js）。
//
// 环境变量：RUNTIME_ARN  USER_POOL_ID  CLIENT_ID  ORIGIN_SECRET

import { CognitoIdentityProviderClient, AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'

const env = process.env
const REGION = env.AWS_REGION
const INVOKE_URL = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(env.RUNTIME_ARN)}/invocations?qualifier=DEFAULT`
const cognito = new CognitoIdentityProviderClient({ region: REGION })
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'host'])

const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录 · DSH on AgentCore</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;margin-top:12vh}form{display:flex;flex-direction:column;gap:12px;width:280px}
input,button{font-size:15px;padding:8px}p{color:#c00;min-height:1em}</style></head><body>
<form method="post" action="/auth/login"><h2>DSH on AgentCore</h2><label for="u">用户名</label><input id="u" name="username" autocomplete="username" required>
<label for="p">口令</label><input id="p" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button><p role="alert">${msg}</p></form></body></html>`

function reply(stream, status, headers, body) {
  const s = awslambda.HttpResponseStream.from(stream, { statusCode: status, headers })
  // 先 write 再 end：from() 之后直接 end(body) 会得到 502（Spike 04）
  if (body !== undefined && body !== '') s.write(body)
  s.end()
}

function cookie(event, name) {
  for (const c of event.cookies ?? []) {
    const i = c.indexOf('=')
    if (c.slice(0, i).trim() === name) return c.slice(i + 1)
  }
  return null
}

function subOf(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub ?? null } catch { return null }
}

async function login(event, stream) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '')
  const form = new URLSearchParams(raw)
  const username = form.get('username') ?? ''
  const password = form.get('password') ?? ''
  try {
    const r = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: env.USER_POOL_ID, ClientId: env.CLIENT_ID, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }))
    const token = r.AuthenticationResult?.AccessToken
    if (!token) throw new Error('no token')
    const maxAge = r.AuthenticationResult.ExpiresIn ?? 3600
    const s = awslambda.HttpResponseStream.from(stream, {
      statusCode: 303,
      headers: { location: '/', 'cache-control': 'no-store' },
      cookies: [`dsh_token=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`],
    })
    s.write('')
    s.end()
  } catch {
    reply(stream, 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, LOGIN_HTML('用户名或口令错误'))
  }
}

async function tunnel(event, stream, token) {
  const sub = subOf(token)
  if (!sub) return reply(stream, 401, { 'content-type': 'text/plain' }, 'bad token')
  const headers = {}
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (HOP.has(k) || k.startsWith('x-amz') || k.startsWith('x-forwarded') || k === 'x-origin-verify' || k === 'x-dsh-raw-query' || k.startsWith('cloudfront-')) continue
    headers[k] = v
  }
  const body = event.body ? (event.isBase64Encoded ? event.body : Buffer.from(event.body, 'utf8').toString('base64')) : null
  // 以「?」开头的查询串（/plugins/??a,b&rev=）由 CloudFront Function 搬进 x-dsh-raw-query 头（见 cloud/cf-default-function.js）
  const rawQuery = event.headers?.['x-dsh-raw-query'] ? decodeURIComponent(event.headers['x-dsh-raw-query']) : event.rawQueryString
  const payload = JSON.stringify({
    v: 1, method: event.requestContext.http.method,
    path: event.rawPath + (rawQuery ? `?${rawQuery}` : ''), headers, body,
  })
  const sessionId = `dsh-user-${sub}`
  const t0 = Date.now()
  const r = await fetch(INVOKE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/octet-stream',
      'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
    },
    body: payload,
  })
  if (r.status === 401 || r.status === 403) {
    // 令牌过期或无效：清 cookie 回登录页（只对页面导航这样做，API 调用直接返回状态码）
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/') {
      const s = awslambda.HttpResponseStream.from(stream, { statusCode: 303, headers: { location: '/auth/login' }, cookies: ['dsh_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'] })
      s.write(''); s.end(); return
    }
    return reply(stream, r.status, { 'content-type': 'text/plain' }, await r.text())
  }
  if (r.status !== 200) return reply(stream, 502, { 'content-type': 'text/plain' }, `agentcore ${r.status}: ${(await r.text()).slice(0, 300)}`)
  // 拆出封包的第一行元数据，其余字节原样流回
  const reader = r.body.getReader()
  let buf = Buffer.alloc(0)
  let head = null
  while (!head) {
    const { value, done } = await reader.read()
    if (done) return reply(stream, 502, { 'content-type': 'text/plain' }, 'tunnel response ended before header')
    buf = Buffer.concat([buf, Buffer.from(value)])
    const nl = buf.indexOf(0x0a)
    if (nl >= 0) { head = JSON.parse(buf.subarray(0, nl).toString('utf8')); buf = buf.subarray(nl + 1) }
  }
  const outHeaders = {}
  const cookies = []
  for (const [k, v] of Object.entries(head.headers ?? {})) {
    if (HOP.has(k)) continue
    if (k === 'set-cookie') { cookies.push(...(Array.isArray(v) ? v : [v])); continue }
    outHeaders[k] = Array.isArray(v) ? v.join(', ') : v
  }
  const s = awslambda.HttpResponseStream.from(stream, { statusCode: head.status, headers: outHeaders, cookies })
  // 至少写一次：空响应体时若不 write，状态码与头不会发出，Function URL 退回 200 application/octet-stream（阶段 3 实测）
  s.write(buf)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    s.write(Buffer.from(value))
  }
  s.end()
  console.log(JSON.stringify({ path: event.rawPath, query: (rawQuery ?? '').slice(0, 80), viaHeader: Boolean(event.headers?.['x-dsh-raw-query']), status: head.status, ms: Date.now() - t0, sessionId }))
}

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if ((event.headers?.['x-origin-verify'] ?? '') !== env.ORIGIN_SECRET) return reply(stream, 403, { 'content-type': 'text/plain' }, 'forbidden')
  const path = event.rawPath
  const method = event.requestContext.http.method
  if (path === '/auth/login' && method === 'GET') return reply(stream, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, LOGIN_HTML())
  if (path === '/auth/login' && method === 'POST') return login(event, stream)
  if (path === '/auth/logout') {
    const s = awslambda.HttpResponseStream.from(stream, { statusCode: 303, headers: { location: '/auth/login' }, cookies: ['dsh_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'] })
    s.write(''); s.end(); return
  }
  const token = cookie(event, 'dsh_token')
  if (!token) {
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const s = awslambda.HttpResponseStream.from(stream, { statusCode: 303, headers: { location: '/auth/login' } })
      s.write(''); s.end(); return
    }
    return reply(stream, 401, { 'content-type': 'text/plain' }, 'login required')
  }
  try { await tunnel(event, stream, token) } catch (e) {
    console.error(JSON.stringify({ level: 'error', path, error: e.message }))
    reply(stream, 502, { 'content-type': 'text/plain' }, 'tunnel error')
  }
})

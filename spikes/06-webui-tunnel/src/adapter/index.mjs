// 容器内适配器：满足 AgentCore Runtime 的 HTTP 协议契约（:8080 GET /ping、POST /invocations、WebSocket /ws），
// 把官方 `dsh web` 隧道出去。DSH 只监听 127.0.0.1，浏览器永远不直接接触它。
//
//   POST /invocations  请求体是封包后的浏览器 HTTP 请求（src/lib/envelope.mjs），转发到 127.0.0.1:DSH_PORT，
//                      响应以「元数据行 + 原始字节」流式写回
//   /ws                与 DSH 的 /api/remote.mux 双向对接
//   GET /ping          DSH 就绪前 HealthyBusy，之后 Healthy
//
// DSH 自带的鉴权（启动 token → 绑定 Host 的 HMAC cookie、Host/Origin 白名单）由适配器代办：
// 启动后从 stdout 读出 token 并自行换取 cookie；之后每个转发请求都把 Host 改成 127.0.0.1:DSH_PORT、
// 注入该 cookie、去掉 Origin / Sec-Fetch-*；响应里 DSH 的 Set-Cookie 不回传给浏览器。
// 用户身份与会话路由由上游（网关 / AgentCore 的 JWT 授权器）负责，不在这里。
//
// 环境变量：
//   PORT=8080  DSH_PORT=3080  USER_HOME（持久磁盘挂载点）  WORKSPACE_DIR  DSH_HOME  DSH_PATCHES（逗号分隔的补丁路径）
//   MODEL_ID  MODEL_REGION  MODEL_BASE_URL（签名代理的上游）  EGRESS_PROXY（可选，测试用）
//   SIGNER_FAKE_CREDS=1（本机测试用假凭证；缺省用默认凭证链 = AgentCore 执行角色）
//   REQUIRE_SESSION_OWNER=1（阶段 3：要求请求带 AgentCore 已验签的 Bearer JWT，且会话 ID 必须等于 dsh-user-<JWT.sub>）
//   MOCK_MODEL=1（容器内启动模拟模型上游并用假凭证签名；阶段 2 只验证隧道与存储，不调用真实 Bedrock）

import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { decodeRequest, encodeResponseHead, HOP_HEADERS } from '../lib/envelope.mjs'
import { startSigningProxy } from '../lib/proxies.mjs'
import { startMockUpstream } from '../lib/mock-upstream.mjs'
import { restoreHome, startHomeMirror } from './home-mirror.mjs'

const require = createRequire(import.meta.url)
const DSH_BIN = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')

const env = process.env
const PORT = Number(env.PORT ?? 8080)
const DSH_PORT = Number(env.DSH_PORT ?? 3080)
const DSH_AUTHORITY = `127.0.0.1:${DSH_PORT}`
// 持久磁盘即用户的主目录：DSH 的目录选择器默认从 HOME 开始浏览，用户在其中选择/新建工作区目录。
// DSH 自己的状态（会话日志、profile、cookie 签名密钥）放在隐藏目录 $HOME/.dsh。
const USER_HOME = resolve(env.USER_HOME ?? '/mnt/workspace')
const WORKSPACE_DIR = resolve(env.WORKSPACE_DIR ?? join(USER_HOME, 'workspace'))
// DSH_HOME 在本地磁盘运行，镜像到持久目录 $HOME/.dsh（原因见 home-mirror.mjs）；DSH_HOME_MIRROR=0 时直接放在持久目录
const DSH_HOME_PERSIST = resolve(env.DSH_HOME ?? join(USER_HOME, '.dsh'))
const MIRROR = env.DSH_HOME_MIRROR !== '0'
const DSH_HOME = MIRROR ? resolve(env.DSH_HOME_LOCAL ?? '/tmp/dsh-home') : DSH_HOME_PERSIST
let mirror = null
// 补丁路径相对于包根目录解析（AgentCore 代码包的工作目录不固定）
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATCHES = (env.DSH_PATCHES ?? '').split(',').filter(Boolean).map((p) => resolve(PKG_ROOT, p))
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }))

const state = { dshReady: false, cookie: null, startedAt: Date.now(), readyMs: null, inflight: 0, dsh: null }
// microVM 冷启动时，第一批浏览器请求会在 dsh web 就绪前到达：挂起等待而不是返回 503，否则页面本身就加载失败
let markReady
const readyPromise = new Promise((r) => { markReady = r })
const whenReady = (ms) => Promise.race([readyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('dsh not ready')), ms))])

// ---------------- 模型签名代理 ----------------
async function startSigner() {
  if (env.MOCK_MODEL) {
    const mock = await startMockUpstream({})
    env.MODEL_BASE_URL = mock.base
    env.SIGNER_FAKE_CREDS = '1'
    log('info', 'mock model upstream up', { base: mock.base })
  }
  const credentials = env.SIGNER_FAKE_CREDS
    ? { accessKeyId: 'AKIDSPIKE06EXAMPLE', secretAccessKey: 'spike06-fake-secret-key' }
    : (await import('@aws-sdk/credential-provider-node')).defaultProvider()
  // MODEL_SIGNING_SERVICE：bedrock-runtime 端点面用 bedrock（默认），bedrock-mantle 端点面用 bedrock-mantle（Spike 07）
  return startSigningProxy({
    upstreamBase: env.MODEL_BASE_URL, region: env.MODEL_REGION ?? 'us-east-1', service: env.MODEL_SIGNING_SERVICE ?? 'bedrock', credentials,
    stripRawToolMarkup: env.MODEL_STRIP_RAW_TOOL_MARKUP !== '0',
    // 每次模型调用一条结构化日志：状态码、耗时、是否被 DSH 取消、剥离的原始标记次数、错误摘要（不含请求体与凭证）
    onEntry: (e) => log(e.upstreamStatus === 200 && !e.error ? 'info' : 'warn', 'model call', {
      path: e.path, status: e.upstreamStatus ?? null, ms: e.ms, bytesIn: e.bodyBytes, cancelled: e.downstreamClosedEarly,
      strippedRawToolMarkup: e.strippedRawToolMarkup ?? 0, error: e.error, errorBody: e.errorBody,
    }),
  })
}

// ---------------- DSH 子进程与鉴权代办 ----------------
async function startDsh(signerBase) {
  mkdirSync(WORKSPACE_DIR, { recursive: true })
  mkdirSync(DSH_HOME, { recursive: true })
  if (MIRROR) {
    const t = Date.now()
    const r = restoreHome(DSH_HOME_PERSIST, DSH_HOME)
    mirror = startHomeMirror({ localDir: DSH_HOME, persistDir: DSH_HOME_PERSIST, intervalMs: Number(env.DSH_HOME_MIRROR_MS ?? 2000), log })
    log('info', 'dsh home restored from persistent dir', { ...r, ms: Date.now() - t, persist: DSH_HOME_PERSIST, local: DSH_HOME })
  }
  const args = [DSH_BIN, '--profile', 'web', ...PATCHES.flatMap((p) => ['--patch', p]), '--port', String(DSH_PORT), '--no-open']
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: env.PATH, LANG: 'C.UTF-8', HOME: USER_HOME,
      DSH_HOME, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_BRIDGE_MODEL_ID: env.MODEL_ID, DSH_BRIDGE_MODEL_BASE_URL: `${signerBase}/openai/v1`,
      DSH_BRIDGE_PLACEHOLDER_KEY: 'placeholder-not-a-secret',
      ...(env.EGRESS_PROXY ? { HTTP_PROXY: env.EGRESS_PROXY, HTTPS_PROXY: env.EGRESS_PROXY, ALL_PROXY: env.EGRESS_PROXY, NO_PROXY: '' } : {}),
    },
  })
  state.dsh = child
  child.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`))
  child.on('exit', (code, signal) => { log('error', 'dsh exited', { code, signal }); state.dshReady = false })

  // 启动完成时 DSH 在 stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`
  const tokenUrl = await new Promise((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error(`dsh web did not print its launch URL in 120 s; stdout tail: ${buf.slice(-500)}`)), 120000)
    child.stdout.on('data', (d) => {
      buf += d
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(buf)
      if (m) { clearTimeout(t); res(m[1]) }
    })
    child.on('exit', () => rej(new Error(`dsh exited before ready; stdout tail: ${buf.slice(-500)}`)))
  })
  // 换取 cookie（303 + Set-Cookie: dsh-auth-<hash(authority)>=...）
  const r = await fetch(tokenUrl, { redirect: 'manual', headers: { host: DSH_AUTHORITY } })
  const setCookie = r.headers.getSetCookie?.() ?? []
  const auth = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('dsh-auth-'))
  if (r.status !== 303 || !auth) throw new Error(`token exchange failed: ${r.status} ${setCookie.join(' | ')}`)
  state.cookie = auth
  state.dshReady = true
  state.readyMs = Date.now() - state.startedAt
  markReady()
  log('info', 'dsh web ready', { readyMs: state.readyMs, pid: child.pid })
}

// 把浏览器请求头改写成 DSH 能接受的形态
function toDshHeaders(inHeaders) {
  const out = {}
  for (const [k0, v] of Object.entries(inHeaders ?? {})) {
    const k = k0.toLowerCase()
    if (HOP_HEADERS.has(k) || k === 'origin' || k.startsWith('sec-fetch-') || k === 'cookie' || k === 'authorization') continue
    if (k.startsWith('x-amzn-') || k.startsWith('x-amz-')) continue
    out[k] = v
  }
  out.host = DSH_AUTHORITY
  out.cookie = state.cookie
  return out
}

function fromDshHeaders(inHeaders) {
  const out = {}
  for (const [k, v] of Object.entries(inHeaders)) {
    if (HOP_HEADERS.has(k)) continue
    if (k === 'set-cookie') {
      const kept = (Array.isArray(v) ? v : [v]).filter((c) => !c.startsWith('dsh-auth-'))
      if (kept.length) out[k] = kept
      continue
    }
    out[k] = v
  }
  return out
}

// ---------------- 会话归属校验 ----------------
// AgentCore 的 JWT 授权器只验证令牌本身，不把 runtimeSessionId 与用户绑定：任何持有有效令牌的人都能直接调用
// 任意会话 ID。会话 ID 按 dsh-user-<sub> 派生，这里用 AgentCore 转发进来的 Authorization（Runtime 的
// requestHeaderAllowlist 放行）核对两者一致。令牌签名已由 AgentCore 验证，这里只解码 payload。
function sessionOwnerRejection(headers) {
  if (!env.REQUIRE_SESSION_OWNER) return null
  const sid = headers['x-amzn-bedrock-agentcore-runtime-session-id']
  const auth = headers.authorization ?? ''
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(auth)
  if (!m) return 'missing bearer token'
  let sub
  try { sub = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')).sub } catch { return 'malformed token' }
  if (!sub || sid !== `dsh-user-${sub}`) return `session ${sid} does not belong to token subject`
  return null
}

// ---------------- /invocations：HTTP 隧道 ----------------
function handleInvocation(req, res) {
  const chunks = []
  req.on('data', (d) => chunks.push(d))
  req.on('end', async () => {
    const t0 = Date.now()
    let env0
    try { env0 = decodeRequest(Buffer.concat(chunks)) } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `bad envelope: ${e.message}` })); return
    }
    const rejection = sessionOwnerRejection(req.headers)
    if (rejection) {
      log('warn', 'session owner check failed', { reason: rejection })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.concat([encodeResponseHead({ status: 403, headers: { 'content-type': 'text/plain' } }), Buffer.from('forbidden')]))
      return
    }
    if (!state.dshReady) {
      try { await whenReady(90000) } catch {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(encodeResponseHead({ status: 503, headers: { 'content-type': 'text/plain', 'retry-after': '1' } }))
        res.end('dsh starting'); return
      }
    }
    state.inflight++
    const up = http.request({ host: '127.0.0.1', port: DSH_PORT, method: env0.method, path: env0.path, headers: toDshHeaders(env0.headers) }, (ur) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' })
      res.write(encodeResponseHead({ status: ur.statusCode, headers: fromDshHeaders(ur.headers) }))
      ur.on('data', (d) => res.write(d))
      ur.on('end', () => {
        res.end(); state.inflight--
        log('debug', 'tunnel', { method: env0.method, path: env0.path.slice(0, 120), status: ur.statusCode, ms: Date.now() - t0 })
      })
    })
    up.on('error', (e) => {
      state.inflight--
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.concat([encodeResponseHead({ status: 502, headers: { 'content-type': 'text/plain' } }), Buffer.from(`adapter upstream error: ${e.message}`)]))
    })
    // 调用方断开（例如浏览器取消了一个长请求）时中止到 DSH 的请求
    res.on('close', () => { if (!res.writableEnded) up.destroy() })
    up.end(env0.body)
  })
}

// ---------------- /ws：WebSocket 对接 ----------------
// AgentCore /ws 对单个帧有 64 KB 上限：超过时以 1009「message size limit of 64 KB for a message frame is exceeded」
// 关闭连接（Spike 09：会话历史较长时，刷新页面后 DSH 一次推送的历史快照超过 64 KB，连接反复被关闭）。
// 发往 AgentCore 一侧的大消息拆成多个续帧（RFC 6455 分片，fin=false … fin=true），每帧不超过 WS_FRAME_MAX 字节。
const WS_FRAME_MAX = Number(env.WS_FRAME_MAX ?? 48 * 1024)
function sendFragmented(ws, data, isBinary) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buf.length <= WS_FRAME_MAX) { ws.send(buf, { binary: isBinary }); return }
  for (let off = 0; off < buf.length; off += WS_FRAME_MAX) {
    ws.send(buf.subarray(off, off + WS_FRAME_MAX), { binary: isBinary, fin: off + WS_FRAME_MAX >= buf.length })
  }
  log('debug', 'ws message fragmented', { bytes: buf.length, frames: Math.ceil(buf.length / WS_FRAME_MAX) })
}
const wss = new WebSocketServer({ noServer: true })
function bridgeWebSocket(client, req) {
  const upstream = new WebSocket(`ws://${DSH_AUTHORITY}/api/remote.mux`, {
    headers: { cookie: state.cookie, host: DSH_AUTHORITY },
    perMessageDeflate: false,
  })
  const pending = []
  upstream.on('open', () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }) })
  // AgentCore /ws 在约 60 s 无数据时断开连接（阶段 2 实测 1006）；DSH 服务端的 ping 只到适配器这一跳，
  // 所以适配器自己每 WS_KEEPALIVE_MS 向 AgentCore 一侧发 ping 控制帧
  const keepalive = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.ping() }, Number(env.WS_KEEPALIVE_MS ?? 20000))
  const opened = Date.now()
  const counts = { rx: 0, tx: 0 }
  let closedBy = null
  client.on('message', (d, isBinary) => {
    counts.rx++
    if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: isBinary })
    else pending.push([d, isBinary])
  })
  upstream.on('message', (d, isBinary) => { counts.tx++; if (client.readyState === WebSocket.OPEN) sendFragmented(client, d, isBinary) })
  const closeBoth = (code, reason) => {
    clearInterval(keepalive)
    const c = typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011
    if (client.readyState <= WebSocket.OPEN) client.close(c, reason)
    if (upstream.readyState <= WebSocket.OPEN) upstream.close(c, reason)
  }
  // 记录由哪一侧先关闭、关闭码与原因（Spike 09：定位回收后刷新页面时连接反复被关闭的问题）
  const onClose = (side) => (code, reason) => {
    if (!closedBy) {
      closedBy = side
      log('info', 'ws closed', { closedBy: side, code, reason: String(reason ?? '').slice(0, 120), lifetimeMs: Date.now() - opened, framesFromClient: counts.rx, framesFromDsh: counts.tx })
    }
    closeBoth(code, reason)
  }
  client.on('close', onClose('client'))
  upstream.on('close', onClose('dsh'))
  upstream.on('error', (e) => { log('warn', 'upstream ws error', { error: e.message }); closeBoth(1011, 'upstream error') })
  client.on('error', () => closeBoth(1011))
  log('info', 'ws bridged', { sessionHeader: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ?? null, hasAuthorization: Boolean(req.headers.authorization) })
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: state.dshReady ? 'Healthy' : 'HealthyBusy', time_of_last_update: Math.floor(Date.now() / 1000) }))
    return
  }
  if (req.method === 'POST' && req.url.startsWith('/invocations')) return handleInvocation(req, res)
  res.writeHead(404); res.end()
})
server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return }
  const rejection = sessionOwnerRejection(req.headers)
  if (rejection) { log('warn', 'ws session owner check failed', { reason: rejection }); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  if (!state.dshReady) { try { await whenReady(90000) } catch { socket.destroy(); return } }
  wss.handleUpgrade(req, socket, head, (client) => bridgeWebSocket(client, req))
})

const signer = await startSigner()
log('info', 'signing proxy up', { base: signer.base })
server.listen(PORT, '0.0.0.0', () => log('info', 'adapter listening', { port: PORT }))
startDsh(signer.base).catch((e) => { log('error', 'dsh start failed', { error: e.message }); process.exitCode = 1 })

const shutdown = () => {
  log('info', 'shutdown requested')
  state.dsh?.kill('SIGTERM')
  server.close()
  // 等 DSH 写完最后的日志再做最后一次镜像同步
  setTimeout(() => { try { mirror?.stop(); log('info', 'final home mirror sync', mirror?.stats ?? {}) } catch (e) { log('error', 'final sync failed', { error: e.message }) } process.exit(0) }, 1500).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

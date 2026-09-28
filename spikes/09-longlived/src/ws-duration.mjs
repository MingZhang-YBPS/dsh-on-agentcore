// WebSocket 时长对照实验（阶段 L 发现页面与原始 WS 都在约 11 分钟时断开）。四个新用户各自一个全新 microVM，并行运行 MINUTES 分钟：
//   V1 直连 AgentCore /ws（Authorization 头），客户端不发任何帧
//   V2 直连 AgentCore /ws，客户端每 20 s 发 ping 控制帧
//   V3 经 CloudFront /api/remote.mux，客户端不发任何帧
//   V4 经 CloudFront，另外每 4 分钟发一次 HTTP 请求（GET /favicon.svg 经隧道 Lambda → InvokeAgentRuntime），让会话「不空闲」
// 记录每条连接的打开、收到的 ping、关闭时间与关闭码；结束后读取适配器的 ws closed / shutdown 日志。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const exec = promisify(execFile)
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const S06 = join(DIR, '..', '06-webui-tunnel')
const RESULTS = join(DIR, 'results'); mkdirSync(RESULTS, { recursive: true })
const MINUTES = Number(process.env.MINUTES ?? 25)
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')]))
const st = readEnv(join(S06, '.state', 'state.env'))
const aws = async (...a) => JSON.parse((await exec('aws', [...a, '--output', 'json'])).stdout || 'null')
const T0 = Date.now()
const s = () => Math.round((Date.now() - T0) / 1000)

async function user(name) {
  const pass = `Aa1!${randomBytes(10).toString('hex')}`
  await aws('cognito-idp', 'admin-create-user', '--user-pool-id', st.POOL_ID, '--username', name, '--message-action', 'SUPPRESS').catch(() => {})
  await aws('cognito-idp', 'admin-set-user-password', '--user-pool-id', st.POOL_ID, '--username', name, '--password', pass, '--permanent')
  const r = await aws('cognito-idp', 'admin-initiate-auth', '--user-pool-id', st.POOL_ID, '--client-id', st.CLIENT_ID, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${name},PASSWORD=${pass}`)
  const tok = r.AuthenticationResult.AccessToken
  return { tok, sid: `dsh-user-${JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')).sub}` }
}

function watch(label, url, headers, { clientPingMs, httpEveryMs, tok } = {}) {
  return new Promise((res) => {
    const r = { label, openedS: null, closedS: null, code: null, pings: 0, lastPingS: null, msgs: 0, http: [], error: null }
    const ws = new WebSocket(url, { headers })
    let iv = null; let hv = null
    const done = () => { clearInterval(iv); clearInterval(hv); clearTimeout(tm); res(r) }
    const tm = setTimeout(() => { r.stillOpenAtEnd = ws.readyState === WebSocket.OPEN; ws.terminate(); done() }, MINUTES * 60000)
    ws.on('open', () => {
      r.openedS = s()
      if (clientPingMs) iv = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), clientPingMs)
      if (httpEveryMs) hv = setInterval(async () => {
        const x = await fetch(`https://${st.DIST_DOMAIN}/favicon.svg`, { headers: { cookie: `dsh_token=${tok}` } }).then((y) => y.status, (e) => e.message)
        r.http.push(`${s()}s:${x}`)
      }, httpEveryMs)
    })
    ws.on('ping', () => { r.pings++; r.lastPingS = s() })
    ws.on('message', () => { r.msgs++ })
    ws.on('unexpected-response', (_q, x) => { r.error = `HTTP ${x.statusCode}`; done() })
    ws.on('error', (e) => { r.error = e.message })
    ws.on('close', (code) => { r.closedS = s(); r.code = code; console.log(`${label} closed at ${r.closedS}s code ${code} (pings ${r.pings}, last ping ${r.lastPingS}s)`); done() })
  })
}

const direct = (sid) => `wss://bedrock-agentcore.${st.REGION}.amazonaws.com/runtimes/${encodeURIComponent(st.RUNTIME_ARN)}/ws?qualifier=DEFAULT&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${sid}`
const cf = `wss://${st.DIST_DOMAIN}/api/remote.mux`
const [u1, u2, u3, u4] = await Promise.all(['wsd-v1', 'wsd-v2', 'wsd-v3', 'wsd-v4'].map(user))
console.log(`start ${new Date().toISOString()} for ${MINUTES} min`)
const out = await Promise.all([
  watch('V1 直连，无客户端帧', direct(u1.sid), { Authorization: `Bearer ${u1.tok}` }),
  watch('V2 直连，客户端每 20 s ping', direct(u2.sid), { Authorization: `Bearer ${u2.tok}` }, { clientPingMs: 20000 }),
  watch('V3 CloudFront，无客户端帧', cf, { cookie: `dsh_token=${u3.tok}` }),
  watch('V4 CloudFront + 每 4 分钟 HTTP', cf, { cookie: `dsh_token=${u4.tok}` }, { httpEveryMs: 240000, tok: u4.tok }),
])
const lg = `/aws/bedrock-agentcore/runtimes/${st.RUNTIME_ID}-DEFAULT`
const logs = {}
for (const [k, u] of [['V1', u1], ['V2', u2], ['V3', u3], ['V4', u4]]) {
  const { stdout } = await exec('aws', ['logs', 'filter-log-events', '--log-group-name', lg, '--start-time', String(T0 - 60000), '--log-stream-name-prefix', `${new Date(T0).toISOString().slice(0, 10).replace(/-/g, '/')}/[runtime-logs-${u.sid}]`, '--query', 'events[].[timestamp,message]', '--output', 'json'], { maxBuffer: 1 << 24 }).catch((e) => ({ stdout: '[]' }))
  logs[k] = JSON.parse(stdout).map(([ts, m]) => `${Math.round((ts - T0) / 1000)}s ${m}`).filter((l) => /ws closed|ws bridged|shutdown|dsh web ready|final home/.test(l)).map((l) => l.slice(0, 260))
}
writeFileSync(join(RESULTS, 'ws-duration.json'), JSON.stringify({ startedAt: new Date(T0).toISOString(), minutes: MINUTES, results: out, adapterLogs: logs }, null, 1))
for (const r of out) console.log(JSON.stringify(r))
for (const [k, l] of Object.entries(logs)) console.log(k, JSON.stringify(l))
process.exit(0)

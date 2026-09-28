// 在 EC2（us-east-1，同区域、稳定网络）上运行的长连接探针，排除本机网络抖动的影响。
// 环境变量：CONFIG（JSON：{region, runtimeArn, dist, minutes, users:[{label, tok, sid}]}）、OUT（结果文件）
// 四条连接并行：
//   V1 直连 AgentCore /ws，客户端不发帧
//   V2 直连，客户端每 20 s ping
//   V3 经 CloudFront /api/remote.mux，客户端不发帧
//   V4 经 CloudFront，另外每 4 分钟 GET /favicon.svg（经隧道 → InvokeAgentRuntime）
// 令牌有效期 60 分钟，minutes 大于 60 时同时观察「令牌过期后已建立的连接」。
import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const cfg = JSON.parse(process.env.CONFIG)
const T0 = Date.now()
const s = () => Math.round((Date.now() - T0) / 1000)
const direct = (sid) => `wss://bedrock-agentcore.${cfg.region}.amazonaws.com/runtimes/${encodeURIComponent(cfg.runtimeArn)}/ws?qualifier=DEFAULT&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${sid}`
function watch(u) {
  const viaCf = u.label.startsWith('V3') || u.label.startsWith('V4')
  const url = viaCf ? `wss://${cfg.dist}/api/remote.mux` : direct(u.sid)
  const headers = viaCf ? { cookie: `dsh_token=${u.tok}` } : { Authorization: `Bearer ${u.tok}` }
  return new Promise((res) => {
    const r = { label: u.label, openedS: null, closedS: null, code: null, reason: null, pings: 0, lastPingS: null, http: [], error: null }
    const ws = new WebSocket(url, { headers })
    let iv; let hv
    const done = () => { clearInterval(iv); clearInterval(hv); clearTimeout(tm); res(r) }
    const tm = setTimeout(() => { r.stillOpenAtEnd = ws.readyState === WebSocket.OPEN; ws.terminate(); done() }, cfg.minutes * 60000)
    ws.on('open', () => {
      r.openedS = s()
      if (u.label.startsWith('V2')) iv = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 20000)
      if (u.label.startsWith('V4')) hv = setInterval(async () => { r.http.push(`${s()}s:${await fetch(`https://${cfg.dist}/favicon.svg`, { headers: { cookie: `dsh_token=${u.tok}` } }).then((y) => y.status, (e) => e.message)}`) }, 240000)
    })
    ws.on('ping', () => { r.pings++; r.lastPingS = s() })
    ws.on('unexpected-response', (_q, x) => { r.error = `HTTP ${x.statusCode}`; done() })
    ws.on('error', (e) => { r.error = e.message })
    ws.on('close', (code, reason) => { r.closedS = s(); r.code = code; r.reason = String(reason); done() })
  })
}
const out = await Promise.all(cfg.users.map(watch))
writeFileSync(process.env.OUT, JSON.stringify({ startedAt: new Date(T0).toISOString(), minutes: cfg.minutes, results: out }, null, 1))
console.log(JSON.stringify(out))

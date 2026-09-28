// 阶段 2 用例编排：本机网关（SigV4）→ AgentCore Runtime（真实 microVM + 托管 session storage）→ 适配器 → dsh web。
// 前置：aws/build.sh、aws/setup.sh 已执行（.state/state.env 里有 RUNTIME_ARN）；Windows 侧 UI 目录已准备（见 README）。
// 每次运行使用一个新的 runtimeSessionId（= 一个新用户的专属 microVM 与持久目录）。
// 结果：results/agentcore-*.json、results/agentcore-summary.md

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore'
import { startGateway } from '../gateway/local-gateway.mjs'
import { agentcoreTransport } from '../gateway/agentcore-transport.mjs'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(SPIKE_DIR, 'results')
mkdirSync(RESULTS, { recursive: true })
const st = Object.fromEntries(readFileSync(join(SPIKE_DIR, '.state', 'state.env'), 'utf8').split('\n')
  .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/\\(.)/g, '$1')]))
const region = st.REGION ?? 'us-east-1'
const runtimeArn = st.RUNTIME_ARN
const sessionId = process.env.RUNTIME_SESSION_ID ?? `dsh-user-${randomBytes(12).toString('hex')}`
const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike06-ui'
const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
cpSync(join(SPIKE_DIR, 'ui', 'ui-suite.mjs'), join(WIN_UI_DIR, 'ui-suite.mjs'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }

const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.id} ${r.desc}${r.note ? ` — ${r.note}` : ''}`) }
const invokes = []
const transport = agentcoreTransport({ runtimeArn, sessionId, region, onInvoke: (x) => invokes.push({ ...x, at: Date.now() }) })
const gateway = await startGateway({ port: 8001, transport })
const base = gateway.base

async function runUi(phase) {
  const out = `agentcore-${phase}`
  try {
    const { stdout } = await promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node ui-suite.mjs http://localhost:${gateway.port}/ ${phase} ${out} hardened`], { timeout: 600000 })
    process.stdout.write(stdout)
  } catch (e) { process.stdout.write(e.stdout ?? '') }
  const res = JSON.parse(readFileSync(join(WIN_UI_DIR, `${out}.json`), 'utf8'))
  for (const c of res.cases) {
    rows.push({ ...c, phase })
    const png = join(WIN_UI_DIR, `${out}-${c.id}.png`)
    if (existsSync(png)) cpSync(png, join(RESULTS, `${out}-${c.id}.png`))
  }
  writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 2))
}

async function timedGet(path) {
  const t = Date.now()
  const r = await fetch(`${base}${path}`)
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, ms: Date.now() - t, bytes: buf.length, buf }
}

// ---------- 冷启动 ----------
let r = await timedGet('/favicon.svg')
record({ id: 'A01', desc: '新会话首个请求（microVM 冷启动 + 挂载 session storage + dsh web 启动）', pass: r.status === 200, note: `${r.ms} ms，status ${r.status}`, coldStartMs: r.ms })
r = await timedGet('/favicon.svg')
record({ id: 'A02', desc: '热会话单个请求往返（本机 → us-east-1 → microVM → dsh web）', pass: r.status === 200, note: `${r.ms} ms` })

// ---------- 并发 ----------
const t0 = Date.now()
const par = await Promise.all(Array.from({ length: 30 }, (_, i) => timedGet(`/favicon.svg?n=${i}`).catch((e) => ({ status: 0, error: e.message, ms: Date.now() - t0 }))))
const okPar = par.filter((x) => x.status === 200)
record({ id: 'A03', desc: '同一会话 30 个并发 InvokeAgentRuntime', pass: okPar.length === 30, note: `成功 ${okPar.length}/30，总耗时 ${Date.now() - t0} ms，单个 P50 ${pct(par.map((x) => x.ms), 0.5)} ms / 最大 ${Math.max(...par.map((x) => x.ms))} ms`, errors: par.filter((x) => x.status !== 200).map((x) => x.error ?? x.status) })

// ---------- 二进制 ----------
const png = await timedGet('/favicon.svg')
const direct = await timedGet('/manifest.webmanifest')
record({ id: 'A04', desc: '响应字节原样穿过隧道（静态文件）', pass: png.status === 200 && direct.status === 200 && png.bytes > 0, note: `favicon ${png.bytes} B，manifest ${direct.bytes} B` })

// ---------- 浏览器用例（阶段 A） ----------
await runUi('A')

// ---------- 加固：直接调用 settings / credentials ----------
for (const ep of ['settings/describe', 'credentials/set']) {
  const x = await fetch(`${base}/api/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: ep, payload: {} }) })
  record({ id: `A05:${ep}`, desc: `加固补丁下经隧道直接调用 ${ep} 被拒绝`, pass: x.status === 404, note: `status ${x.status}` })
}

// ---------- WebSocket 空闲保持 ----------
const ws = await transport.openWebSocket()
const wsT0 = Date.now()
const wsInfo = await new Promise((res) => {
  let opened = null
  let pings = 0
  ws.on('open', () => { opened = Date.now() - wsT0 })
  ws.on('ping', () => { pings++ })
  ws.on('close', (code, reason) => res({ opened, closedAfterMs: Date.now() - wsT0, code, reason: String(reason), pings }))
  ws.on('error', (e) => res({ opened, error: e.message, pings }))
  setTimeout(() => { ws.close(1000, 'test done'); res({ opened, stillOpenAfterMs: Date.now() - wsT0, pings }) }, 180000)
})
record({ id: 'A06', desc: 'WebSocket 经 AgentCore /ws 连接后空闲保持 180 s（不发业务消息）', pass: Boolean(wsInfo.stillOpenAfterMs), note: JSON.stringify(wsInfo) })

// ---------- 会话停止后恢复（模拟 microVM 回收） ----------
const ac = new BedrockAgentCoreClient({ region })
await ac.send(new StopRuntimeSessionCommand({ agentRuntimeArn: runtimeArn, runtimeSessionId: sessionId, qualifier: 'DEFAULT' }))
await sleep(15000)
r = await timedGet('/favicon.svg')
record({ id: 'A07', desc: 'StopRuntimeSession 后再次访问（新 microVM + 恢复 session storage + dsh web 启动）', pass: r.status === 200, note: `${r.ms} ms`, resumeMs: r.ms })
await runUi('B')
await runUi('C')

const inv = invokes.map((x) => x.ms)
record({ id: 'A08', desc: 'InvokeAgentRuntime 调用统计（本机 WSL → us-east-1）', pass: gateway.stats.errors === 0, note: `共 ${invokes.length} 次，P50 ${pct(inv, 0.5)} ms，P95 ${pct(inv, 0.95)} ms，最大 ${Math.max(...inv)} ms；网关错误 ${gateway.stats.errors}` })
writeFileSync(join(RESULTS, 'agentcore-invokes.json'), JSON.stringify({ sessionId, invokes, gatewayStats: gateway.stats }, null, 2))
writeFileSync(join(RESULTS, 'agentcore-cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 06 阶段 2（AgentCore）结果摘要', '', `- 运行时间：${new Date().toISOString()}；区域 ${region}；Runtime ${runtimeArn}；runtimeSessionId ${sessionId}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((x) => !x.pass).length}`, '', '| 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|']
for (const x of rows) md.push(`| ${x.id} | ${x.desc} | ${String(x.note ?? x.error ?? '').replace(/\|/g, '\\|').slice(0, 220)} | ${x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'agentcore-summary.md'), md.join('\n') + '\n')
gateway.server.close()
await ac.send(new StopRuntimeSessionCommand({ agentRuntimeArn: runtimeArn, runtimeSessionId: sessionId, qualifier: 'DEFAULT' })).catch(() => {})
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)
process.exit(rows.some((x) => !x.pass) ? 1 : 0)

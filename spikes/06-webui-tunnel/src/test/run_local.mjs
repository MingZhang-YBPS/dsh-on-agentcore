// 阶段 1 本机用例编排（WSL 侧）：启动模拟上游 + 适配器 + 网关，调用 Windows 侧 Edge 跑 ui/ui-suite.mjs，
// 并在 WSL 侧核对工作空间文件、模型请求、外联与 /api 直接调用。结果写到 results/local-*.json 与 results/local-summary.md。
//   前置：Windows 侧 C:\Users\<user>\spike06-ui 已 `npm install playwright-core@1.63.0`（见 README）
//   环境变量：WIN_UI_DIR（WSL 路径，默认 /mnt/c/Users/zhang/spike06-ui）

import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDev } from './dev.mjs'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(SPIKE_DIR, 'results')
mkdirSync(RESULTS, { recursive: true })
const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike06-ui'
const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
cpSync(join(SPIKE_DIR, 'ui', 'ui-suite.mjs'), join(WIN_UI_DIR, 'ui-suite.mjs'))
const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.id} ${r.desc}${r.note ? ` — ${r.note}` : ''}`) }

// 必须异步执行：网关与适配器跑在本进程的事件循环里，同步等待会让浏览器请求全部卡住
async function runUi(port, phase) {
  const out = `local-${phase}`
  try {
    const { stdout } = await promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node ui-suite.mjs http://localhost:${port}/ ${phase} ${out}`], { timeout: 300000 })
    process.stdout.write(stdout)
  } catch (e) { process.stdout.write(e.stdout ?? '') /* 用例失败时非零退出，结果仍在 json 里 */ }
  const res = JSON.parse(readFileSync(join(WIN_UI_DIR, `${out}.json`), 'utf8'))
  for (const c of res.cases) {
    rows.push({ ...c, phase })
    if (existsSync(join(WIN_UI_DIR, `${out}-${c.id}.png`))) cpSync(join(WIN_UI_DIR, `${out}-${c.id}.png`), join(RESULTS, `${out}-${c.id}.png`))
  }
  writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 2))
  return res
}

async function apiCall(base, endpoint, payload = {}) {
  const r = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `spike06-${Date.now()}`, method: endpoint, payload }),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, ok: json?.result?.ok ?? null, error: json?.result?.error ?? null, text: json ? undefined : text.slice(0, 200) }
}

const root = mkdtempSync(join(tmpdir(), 'spike06-local-'))

// ---------- 阶段 A：首次使用 ----------
let dev = await startDev({ root, gatewayPort: 8000 })
record({ id: 'L01', desc: '适配器启动到 dsh web 就绪（spawn、token 换 cookie、/ping 变为 Healthy）', pass: true, note: `${dev.readyMs} ms`, readyMs: dev.readyMs })
await runUi(dev.gateway.port, 'A')
const hello = join(root, 'home', 'workspace', 'hello.txt')
record({ id: 'L02', desc: '工具写入的文件落在持久目录的 ~/workspace 下', pass: existsSync(hello) && readFileSync(hello, 'utf8') === 'spike05\n', note: existsSync(hello) ? hello : '文件不存在' })
const slowReq = dev.mock.requests.find((q) => JSON.stringify(q.body?.messages ?? []).includes('慢慢说[[SLOW]]') && q.clientClosedEarly)
record({ id: 'L03', desc: '停止生成后到模型上游的连接被关闭', pass: Boolean(slowReq), note: slowReq ? 'clientClosedEarly=true' : '未观察到提前关闭' })
const settingsOpen = await apiCall(dev.gateway.base, 'settings/describe')
record({ id: 'L04', desc: '未加固时，经网关可直接调用 settings/describe（说明需要加固）', pass: true, detail: settingsOpen, note: `status=${settingsOpen.status} ok=${settingsOpen.ok}` })
record({ id: 'L05', desc: '阶段 A 期间 DSH 进程无非回环外联', pass: dev.egress.attempts.length === 0, detail: dev.egress.attempts, note: `${dev.egress.attempts.length} 次` })
const tunnelStats = dev.gateway.stats
writeFileSync(join(RESULTS, 'local-tunnel-requests.json'), JSON.stringify(tunnelStats, null, 2))
const ms = tunnelStats.perRequestMs.map((x) => x.ms).sort((a, b) => a - b)
record({ id: 'L06', desc: '隧道请求统计（本机，不含 AgentCore 开销）', pass: tunnelStats.errors === 0, note: `HTTP ${tunnelStats.http} 个，WS ${tunnelStats.ws} 条，错误 ${tunnelStats.errors}，P50 ${ms[Math.floor(ms.length / 2)]} ms，P95 ${ms[Math.floor(ms.length * 0.95)]} ms` })
await dev.stop()

// ---------- 阶段 B：DSH 进程重启（模拟 microVM 回收后在同一持久目录上重建） ----------
dev = await startDev({ root, gatewayPort: 8000 })
record({ id: 'L07', desc: '重启后 dsh web 就绪（同一持久目录，cookie 签名密钥与会话日志已存在）', pass: true, note: `${dev.readyMs} ms` })
await runUi(dev.gateway.port, 'B')
const reqB = dev.mock.requests.find((q) => JSON.stringify(q.body?.messages ?? []).includes('还记得吗'))
const usersB = (reqB?.body?.messages ?? []).filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content))
record({ id: 'L08', desc: '重启后在旧会话继续对话：模型请求包含重启前的历史（DSH 从 JSONL 恢复会话）', pass: usersB.some((t) => t.includes('打个招呼')) && usersB.some((t) => t.includes('写一个文件')), note: `请求中用户消息 ${usersB.length} 条` })
await dev.stop()

// ---------- 阶段 C：加固补丁 ----------
dev = await startDev({ root, gatewayPort: 8000, hardening: true })
record({ id: 'L09', desc: '加固补丁下 dsh web 能启动', pass: true, note: `${dev.readyMs} ms` })
await runUi(dev.gateway.port, 'C')
for (const ep of ['settings/describe', 'settings/update', 'credentials/describe', 'credentials/set']) {
  const r = await apiCall(dev.gateway.base, ep, ep === 'credentials/set' ? { ref: 'DSH_BRIDGE_PLACEHOLDER_KEY', value: 'x' } : {})
  record({ id: `L10:${ep}`, desc: `加固后经 /api 直接调用 ${ep} 被拒绝`, pass: r.ok !== true, detail: r, note: `status=${r.status} ok=${r.ok} ${JSON.stringify(r.error ?? r.text ?? '').slice(0, 120)}` })
}
record({ id: 'L11', desc: '全程 DSH 进程无非回环外联', pass: dev.egress.attempts.length === 0, detail: dev.egress.attempts, note: `${dev.egress.attempts.length} 次` })
await dev.stop()

writeFileSync(join(RESULTS, 'local-cases.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const md = ['# Spike 06 阶段 1（本机）结果摘要', '', `- 运行时间：${new Date().toISOString()}；DSH @deepseek-ai/dsh@0.1.5-rc.3；浏览器：Windows 侧 Edge（headless）`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((r) => !r.pass).length}`, '', '| 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|']
for (const r of rows) md.push(`| ${r.id} | ${r.desc} | ${String(r.note ?? r.error ?? '').replace(/\|/g, '\\|').slice(0, 200)} | ${r.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'local-summary.md'), md.join('\n') + '\n')
console.log(`\n${rows.length} cases, ${rows.filter((r) => !r.pass).length} not as expected; state dir ${root}`)
process.exit(rows.some((r) => !r.pass) ? 1 : 0)

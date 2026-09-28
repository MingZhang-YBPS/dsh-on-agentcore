// AgentCore：本机网关（SigV4 调 InvokeAgentRuntime 与 /ws）→ Runtime（执行角色最小权限）→ 适配器 → 签名代理 → 真实 Bedrock。
// 依次把 Runtime 切到三种模型配置，各用一个新的 runtimeSessionId 跑 Windows 侧 ui/real-suite.mjs：
//   A  bedrock-runtime / deepseek.v3.2      phase R
//   B  bedrock-mantle  / deepseek.v3.2      phase R
//   E  bedrock-runtime / openai.gpt-oss-20b-1:0（端点面上存在，但执行角色无权调用）phase E
// 每轮结束后读取该轮 CloudWatch 中适配器的「model call」日志，并 StopRuntimeSession。
// 前置：aws/setup.sh 已执行（.state/state.env）。结果：results/agentcore-*.json、results/agentcore-summary.md

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const S06 = join(DIR, '..', '06-webui-tunnel')
const { startGateway } = await import(join(S06, 'src', 'gateway', 'local-gateway.mjs'))
const { agentcoreTransport } = await import(join(S06, 'src', 'gateway', 'agentcore-transport.mjs'))
const RESULTS = join(DIR, 'results'); mkdirSync(RESULTS, { recursive: true })
const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike07-ui'
const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
cpSync(join(DIR, 'ui', 'real-suite.mjs'), join(WIN_UI_DIR, 'real-suite.mjs'))
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')]))
const exec = promisify(execFile)
const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.pass_ ?? ''}${r.id} ${r.desc}${r.note ? ` — ${r.note}` : ''}`) }

async function runUi(port, phase, out) {
  try {
    const { stdout } = await exec('cmd.exe', ['/c', `cd /d ${winPath} && node real-suite.mjs http://localhost:${port}/ ${phase} ${out}`], { timeout: 900000 })
    process.stdout.write(stdout)
  } catch (e) { process.stdout.write(e.stdout ?? '') }
  const res = JSON.parse(readFileSync(join(WIN_UI_DIR, `${out}.json`), 'utf8'))
  for (const c of res.cases) if (existsSync(join(WIN_UI_DIR, `${out}-${c.id}.png`))) cpSync(join(WIN_UI_DIR, `${out}-${c.id}.png`), join(RESULTS, `${out}-${c.id}.png`))
  writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 2))
  return res
}

async function modelCallLogs(st, sinceMs) {
  const lg = `/aws/bedrock-agentcore/runtimes/${st.RUNTIME_ID}-DEFAULT`
  for (let i = 0; i < 6; i++) {
    try {
      const { stdout } = await exec('aws', ['logs', 'filter-log-events', '--log-group-name', lg, '--start-time', String(sinceMs), '--filter-pattern', '"model call"', '--query', 'events[].message', '--output', 'json'], { maxBuffer: 1 << 24 })
      const msgs = JSON.parse(stdout).map((m) => { try { return JSON.parse(m) } catch { return null } }).filter(Boolean)
      if (msgs.length) return msgs
    } catch { /* 日志组尚未出现 */ }
    await new Promise((r) => setTimeout(r, 10000))
  }
  return []
}

const passes = [
  { name: 'A', surface: 'bedrock-runtime', model: 'deepseek.v3.2', phase: 'R' },
  { name: 'B', surface: 'bedrock-mantle', model: 'deepseek.v3.2', phase: 'R' },
  { name: 'E', surface: 'bedrock-runtime', model: 'openai.gpt-oss-20b-1:0', phase: 'E' },
].filter((p) => !process.env.PASSES || process.env.PASSES.split(',').includes(p.name))

for (const p of passes) {
  console.log(`== pass ${p.name}: ${p.surface} / ${p.model}`)
  const t0c = Date.now()
  await exec('bash', [join(DIR, 'aws', 'configure.sh'), p.surface, p.model], { timeout: 900000 })
  const st = readEnv(join(DIR, '.state', 'state.env'))
  record({ pass_: `${p.name}:`, id: 'A00', desc: '切换 Runtime 模型配置（update-agent-runtime → READY）', pass: true, note: `${Date.now() - t0c} ms，version ${st.RUNTIME_VERSION}` })
  const sessionId = `dsh-user-${randomUUID()}`
  const invokes = []
  const tx = agentcoreTransport({ runtimeArn: st.RUNTIME_ARN, sessionId, region: st.REGION, onInvoke: (x) => invokes.push(x) })
  const g = await startGateway({ port: 8000, transport: tx })
  const since = Date.now()
  const out = `agentcore-${p.name}`
  const res = await runUi(g.port, p.phase, out)
  for (const c of res.cases) rows.push({ pass_: p.name, surface: p.surface, model: p.model, ...c })
  const calls = await modelCallLogs(st, since - 5000)
  const ok = calls.filter((c) => c.status === 200)
  const bad = calls.filter((c) => c.status !== 200)
  const stripped = calls.reduce((n, c) => n + (c.strippedRawToolMarkup ?? 0), 0)
  if (p.phase === 'R') {
    record({ pass_: `${p.name}:`, id: 'A01', desc: 'microVM 内签名代理用执行角色凭证调用模型：全部成功', pass: calls.length > 0 && bad.length === 0, note: `model call ${calls.length} 次，200 ${ok.length} 次，非 200 ${bad.length} 次；DSH 取消 ${calls.filter((c) => c.cancelled).length} 次；剥离原始标记 ${stripped} 次；耗时 P50 ${median(ok.map((c) => c.ms))} ms` })
  } else {
    record({ pass_: `${p.name}:`, id: 'A02', desc: '执行角色无权调用的模型被拒绝（最小权限生效），日志记录拒绝原因', pass: bad.length > 0 && bad.every((c) => c.status === 401 || c.status === 403), note: bad.slice(0, 1).map((c) => `${c.status} ${String(c.errorBody).slice(0, 200)}`).join('') || `无非 200 调用（共 ${calls.length}）` })
  }
  const inv = invokes.map((x) => x.ms).sort((a, b) => a - b)
  record({ pass_: `${p.name}:`, id: 'A03', desc: 'InvokeAgentRuntime 统计（本机 → us-east-1）', pass: true, note: `${inv.length} 次，首个 ${invokes[0]?.ms} ms（冷启动），P50 ${median(inv)} ms，最大 ${inv.at(-1)} ms；网关错误 ${g.stats.errors}` })
  writeFileSync(join(RESULTS, `${out}-model-calls.json`), JSON.stringify(calls, null, 1))
  g.server.close()
  await exec('aws', ['bedrock-agentcore', 'stop-runtime-session', '--agent-runtime-arn', st.RUNTIME_ARN, '--runtime-session-id', sessionId, '--qualifier', 'DEFAULT']).catch(() => {})
}
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

writeFileSync(join(RESULTS, 'agentcore-cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 07 AgentCore（真实 Bedrock 模型）结果摘要', '', `- 运行时间：${new Date().toISOString()}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((x) => !x.pass).length}`, '', '| 轮次 | 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|---|']
for (const x of rows) md.push(`| ${String(x.pass_).replace(':', '')} ${x.surface ?? ''} ${x.model ?? ''} | ${x.id} | ${x.desc} | ${String(x.note ?? x.error ?? '').replace(/\|/g, '\\|').slice(0, 240)} | ${x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'agentcore-summary.md'), md.join('\n') + '\n')
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)
process.exit(0)

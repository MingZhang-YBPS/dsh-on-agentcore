// 本机：Spike 06 的适配器（真实凭证 + 签名代理 → 真实 Bedrock）+ 本地网关 + Windows 侧 Edge 跑 ui/real-suite.mjs。
// 每个「端点面 × 模型」组合各起一个全新的适配器与持久目录。另起一个模型标识无效的适配器跑 phase E。
// 前置：运行目录里 spikes/06-webui-tunnel 已 npm ci（见 run.sh）；Windows 侧 WIN_UI_DIR 已安装 playwright-core@1.63.0。
// 结果：results/local-*.json、results/local-summary.md

import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const S06 = join(DIR, '..', '06-webui-tunnel')
const { startGateway } = await import(join(S06, 'src', 'gateway', 'local-gateway.mjs'))
const { startEgressRecorder } = await import(join(S06, 'src', 'lib', 'proxies.mjs'))
const RESULTS = join(DIR, 'results'); mkdirSync(RESULTS, { recursive: true })
const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike07-ui'
const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
cpSync(join(DIR, 'ui', 'real-suite.mjs'), join(WIN_UI_DIR, 'real-suite.mjs'))
const REGION = process.env.MODEL_REGION ?? 'us-east-1'
const SURF = { 'bedrock-runtime': { base: `https://bedrock-runtime.${REGION}.amazonaws.com/openai/v1`, service: 'bedrock' }, 'bedrock-mantle': { base: `https://bedrock-mantle.${REGION}.api.aws/v1`, service: 'bedrock-mantle' } }
const combos = (process.env.COMBOS ?? 'bedrock-runtime:deepseek.v3.2,bedrock-mantle:deepseek.v3.2,bedrock-mantle:deepseek.v3.1').split(',').map((c) => c.split(':'))
const rows = []

function scanSessionLogs(dir) {
  const out = { files: 0, leaks: [] }
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.jsonl(\.zstd)?$/.test(e.name)) continue
      out.files++
      let s
      try { s = e.name.endsWith('.zstd') ? zstdDecompressSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8') } catch { continue }
      const i = s.search(/DSML|<｜/)
      if (i >= 0) out.leaks.push(`${p.slice(dir.length)}: ${s.slice(Math.max(0, i - 80), i + 60).replace(/\s+/g, ' ')}`)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
async function startAdapter({ modelId, surface, root, port, dshPort, egressUrl }) {
  const s = SURF[surface]
  const child = spawn(process.execPath, [join(S06, 'src', 'adapter', 'index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), DSH_PORT: String(dshPort), USER_HOME: join(root, 'home'), DSH_HOME_LOCAL: join(root, 'local-dsh-home'),
      DSH_PATCHES: 'dsh/web.cordis.yml,dsh/web-hardening.cordis.yml',
      // MODEL_BASE_URL 为端点面的完整 OpenAI 兼容 base；签名代理把 DSH 的 /openai/v1 前缀映射到它的路径上
      MODEL_ID: modelId, MODEL_REGION: REGION, MODEL_BASE_URL: s.base, MODEL_SIGNING_SERVICE: s.service,
      EGRESS_PROXY: egressUrl,
    },
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(...String(d).split('\n').filter(Boolean)))
  child.stderr.on('data', (d) => logs.push(...String(d).split('\n').filter(Boolean)))
  const t0 = Date.now()
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`adapter not ready:\n${logs.slice(-20).join('\n')}`)), 120000)
    const iv = setInterval(async () => {
      try { if ((await (await fetch(`http://127.0.0.1:${port}/ping`)).json()).status === 'Healthy') { clearInterval(iv); clearTimeout(t); res() } } catch { /* 未就绪 */ }
    }, 200)
    child.on('exit', (c) => { clearInterval(iv); clearTimeout(t); rej(new Error(`adapter exited ${c}:\n${logs.slice(-20).join('\n')}`)) })
  })
  return { child, logs, readyMs: Date.now() - t0, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(r, 5000) }) }
}

async function runUi(port, phase, out) {
  try {
    const { stdout } = await promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node real-suite.mjs http://localhost:${port}/ ${phase} ${out}`], { timeout: 900000 })
    process.stdout.write(stdout)
  } catch (e) { process.stdout.write(e.stdout ?? '') }
  const res = JSON.parse(readFileSync(join(WIN_UI_DIR, `${out}.json`), 'utf8'))
  for (const c of res.cases) if (existsSync(join(WIN_UI_DIR, `${out}-${c.id}.png`))) cpSync(join(WIN_UI_DIR, `${out}-${c.id}.png`), join(RESULTS, `${out}-${c.id}.png`))
  writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 2))
  return res
}

const egress = await startEgressRecorder()
let port = 18180
for (const [surface, modelId] of [...combos, ['bedrock-runtime', 'deepseek.not-a-model']]) {
  const phase = modelId === 'deepseek.not-a-model' ? 'E' : 'R'
  const tag = `${surface}-${modelId}`.replace(/[^a-z0-9.-]+/gi, '_')
  const root = mkdtempSync(join(tmpdir(), 'spike07-'))
  const a = await startAdapter({ modelId, surface, root, port, dshPort: port + 1000, egressUrl: egress.url })
  const g = await startGateway({ port: 8000, adapterUrl: `http://127.0.0.1:${port}` })
  console.log(`== ${tag}: adapter ready ${a.readyMs} ms`)
  const res = await runUi(g.port, phase, `local-${tag}`)
  const hello = join(root, 'home', 'workspace', 'hello.txt')
  for (const c of res.cases) rows.push({ combo: tag, ...c })
  if (phase === 'R') rows.push({ combo: tag, id: 'L01', desc: 'bash 工具写入的文件落在 ~/workspace', pass: existsSync(hello) && readFileSync(hello, 'utf8').trim() === 'spike07', note: existsSync(hello) ? JSON.stringify(readFileSync(hello, 'utf8')) : '不存在' })
  const upstreamErr = a.logs.filter((l) => /"level":"(warn|error)"|signing proxy upstream error/.test(l)).slice(-5)
  rows.push({ combo: tag, id: 'L02', desc: '适配器日志中的上游错误', pass: phase === 'E' || upstreamErr.length === 0, note: upstreamErr.join(' | ').slice(0, 300) || '无' })
  if (phase === 'R') {
    // DSH 会话日志（*.jsonl / *.jsonl.zstd）里是否留下了模型原始工具调用标记：界面折叠区之外的旁证
    const hits = scanSessionLogs(join(root, 'local-dsh-home'))
    rows.push({ combo: tag, id: 'L04', desc: 'DSH 会话日志中没有模型原始标记（DSML）', pass: hits.files > 0 && hits.leaks.length === 0, note: `扫描 ${hits.files} 个文件；命中 ${hits.leaks.length}${hits.leaks.length ? `：${hits.leaks[0]}` : ''}` })
  }
  writeFileSync(join(RESULTS, `local-${tag}-adapter.log`), a.logs.join('\n'))
  g.server.close()
  await a.stop()
  port += 10
}
rows.push({ combo: '-', id: 'L03', desc: 'DSH 进程非回环外联（经外联记录代理）', pass: egress.attempts.length === 0, note: `${egress.attempts.length} 次 ${JSON.stringify(egress.attempts.slice(0, 3))}` })
egress.server.close()

writeFileSync(join(RESULTS, 'local-cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 07 本机（适配器 + 真实 Bedrock）结果摘要', '', `- 运行时间：${new Date().toISOString()}；区域 ${REGION}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((x) => !x.pass).length}`, '', '| 组合 | 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|---|']
for (const x of rows) md.push(`| ${x.combo} | ${x.id} | ${x.desc} | ${String(x.note ?? x.error ?? '').replace(/\|/g, '\\|').slice(0, 220)} | ${x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'local-summary.md'), md.join('\n') + '\n')
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)
process.exit(0)

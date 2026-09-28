// Spike 05 用例：本机运行锁定版本的 DSH（无界面），经桥接插件 + 签名代理 + 模拟上游验证六项集成接口。
// 结果：results/cases.jsonl、results/upstream-requests.jsonl、results/summary.md
//
// 所有模型请求都指向本地模拟上游，不调用任何真实 AWS 或 DeepSeek 服务；
// DSH 进程的 HTTP(S)_PROXY 指向外联记录代理，用来发现任何意外的外联请求。

import { mkdtempSync, readdirSync, lstatSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockUpstream } from './mock-upstream.mjs'
import { startSigningProxy, startEgressRecorder } from './proxies.mjs'
import { DshProcess, DSH_BIN } from './driver.mjs'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = join(SPIKE_DIR, 'results')
mkdirSync(RESULTS, { recursive: true })
const MODEL_ID = 'us.deepseek.r1-v1:0'
const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.id} ${r.desc}${r.note ? ` — ${r.note}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pgrep = (pattern) => {
  try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] }
}
const listTree = (dir) => {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const s = lstatSync(p)
      // 不跟随符号链接：DSH 在 $DSH_HOME/profiles/node_modules 为每个依赖包建一个指向安装目录的链接
      out.push(`${relative(dir, p)}${s.isSymbolicLink() ? ' -> (symlink)' : s.isDirectory() ? '/' : ` (${s.size} B)`}`)
      if (s.isDirectory() && !s.isSymbolicLink()) walk(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '')

const dshVersion = JSON.parse(readFileSync(join(dirname(DSH_BIN), '..', 'package.json'), 'utf8')).version
const mock = await startMockUpstream({ model: MODEL_ID })
const proxy = await startSigningProxy({
  upstreamBase: mock.base, region: 'us-east-1',
  // 假凭证：只用来确认签名形态；真实 Bedrock 签名在任务 1.6 验证
  credentials: { accessKeyId: 'AKIDSPIKE05EXAMPLE', secretAccessKey: 'spike05-fake-secret-key' },
})
const egress = await startEgressRecorder()
const workspace = mkdtempSync(join(tmpdir(), 'spike05-ws-'))
const dshHome = mkdtempSync(join(tmpdir(), 'spike05-home-'))
const newProc = (extra = {}) => new DshProcess({ cwd: workspace, dshHome, modelId: MODEL_ID, modelBaseUrl: `${proxy.base}/openai/v1`, egressProxy: egress.url, ...extra })

// ---------- D01 启动 ----------
const t0 = Date.now()
let p = newProc()
const ready = await p.ready()
record({
  id: 'D01', desc: `启动：spawn dsh@${dshVersion} --profile headless --patch bridge.cordis.yml 到桥接插件就绪`,
  detail: { ...ready, spawnToReadyMs: ready.at - t0 }, pass: ready.type === 'ready' && ready.provider === 'bedrock' && ready.model === MODEL_ID && ready.cwd === workspace,
  note: `${ready.at - t0} ms，provider=${ready.provider} model=${ready.model}`,
})

// ---------- D02 文本流式 + 请求形态 ----------
let reqBase = mock.requests.length
let r = await p.prompt('d02', '打个招呼 [[TEXT]]')
const deltas = r.events.filter((e) => e.type === 'delta')
const reasoning = r.events.filter((e) => e.type === 'reasoning')
const req02 = mock.requests[reqBase]
record({
  id: 'D02', desc: '文本回复：token 级 delta 与上游片段一一对应，reasoning_content 单独成流',
  detail: { deltas: deltas.map((e) => e.text), reasoning: reasoning.map((e) => e.text), end: r.end.reason, firstDeltaMs: deltas[0] ? deltas[0].at - r.sentAt : null },
  pass: deltas.map((e) => e.text).join('') === '你好，这是模拟回复。' && deltas.length === 5 && reasoning.length === 2 && r.end.reason?.kind === 'completed',
  note: `${deltas.length} 个 delta、${reasoning.length} 个 reasoning，首个 delta ${deltas[0] ? deltas[0].at - r.sentAt : '-'} ms`,
})
record({
  id: 'D03', desc: '模型请求形态：路径、请求体字段、工具声明（OpenAI tool calling）',
  detail: {
    url: req02.url, bodyKeys: Object.keys(req02.body), model: req02.body.model, stream: req02.body.stream, stream_options: req02.body.stream_options,
    store: req02.body.store, max_completion_tokens: req02.body.max_completion_tokens, max_tokens: req02.body.max_tokens,
    reasoning_effort: req02.body.reasoning_effort, thinking: req02.body.thinking,
    toolNames: (req02.body.tools ?? []).map((t) => t.function?.name), toolType: req02.body.tools?.[0]?.type,
    messageRoles: req02.body.messages.map((m) => m.role), systemPromptChars: textOf(req02.body.messages.find((m) => m.role === 'system' || m.role === 'developer')?.content).length,
    dshFields: Object.keys(req02.body).filter((k) => k.startsWith('dsh_')),
  },
  pass: req02.url === '/openai/v1/chat/completions' && req02.body.stream === true && req02.body.model === MODEL_ID && Array.isArray(req02.body.tools)
    && Object.keys(req02.body).every((k) => !k.startsWith('dsh_')) && req02.body.thinking === undefined
    && !(req02.body.tools ?? []).some((t) => /^web_/.test(t.function?.name ?? '')),
  note: `字段 ${Object.keys(req02.body).join(',')}；工具 ${(req02.body.tools ?? []).length} 个`,
})
const inbound = proxy.log.at(-1)?.inboundHeaders ?? {}
record({
  id: 'D04', desc: '签名注入：DSH → 本地签名代理（占位 Bearer）→ SigV4 签名后到达上游',
  detail: { inboundHeaderNames: Object.keys(inbound).sort(), inboundAuthScheme: inbound.authorization, harnessHeaders: Object.keys(inbound).filter((k) => k.startsWith('x-deepseek') || k.startsWith('x-dsh')), upstreamSigV4: req02.sigv4 },
  pass: req02.sigv4.scheme === 'AWS4-HMAC-SHA256' && req02.sigv4.credentialScope === 'us-east-1/bedrock/aws4_request' && req02.sigv4.contentSha256Matches && req02.sigv4.hasAmzDate
    && String(inbound.authorization).startsWith('Bearer'),
  note: `上游看到 ${req02.sigv4.scheme} scope=${req02.sigv4.credentialScope}，SignedHeaders=${req02.sigv4.signedHeaders}`,
})

// ---------- D05 工具调用：bash 在 /workspace 内写文件 ----------
reqBase = mock.requests.length
r = await p.prompt('d05', '写一个文件 [[TOOL]]')
const calls = r.events.filter((e) => e.type === 'tool_call')
const results = r.events.filter((e) => e.type === 'tool_result')
const hello = join(workspace, 'hello.txt')
record({
  id: 'D05', desc: '工具调用：bash 工具在工作空间（cwd）内执行，tool/call 与 tool/result 事件可映射',
  detail: { calls, results, fileExists: existsSync(hello), content: existsSync(hello) ? readFileSync(hello, 'utf8') : null, workspaceTree: listTree(workspace), finalDeltas: r.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), requests: mock.requests.length - reqBase, secondRequestLastRole: mock.requests.at(-1)?.body?.messages?.at(-1)?.role },
  pass: calls.length === 1 && results.length === 1 && !results[0].isError && existsSync(hello) && readFileSync(hello, 'utf8') === 'spike05\n'
    && results[0].text.includes(workspace) && r.end.reason?.kind === 'completed',
  note: `工具 ${calls[0]?.name}，结果 isError=${results[0]?.isError}，文件 ${existsSync(hello) ? '已写入' : '不存在'}`,
})

// ---------- D06 同一进程第二轮：DSH 自带内存历史 ----------
reqBase = mock.requests.length
r = await p.prompt('d06', '再说一次 [[TEXT]]')
const req06 = mock.requests[reqBase]
const users06 = req06.body.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content))
record({
  id: 'D06', desc: '同一 DSH 进程内的下一轮：请求自动带上此前轮次（含工具调用与结果）',
  detail: { roles: req06.body.messages.map((m) => m.role), userTexts: users06 },
  pass: users06.some((t) => t.includes('打个招呼')) && users06.some((t) => t.includes('写一个文件')) && req06.body.messages.some((m) => m.role === 'tool'),
  note: `消息角色序列 ${req06.body.messages.map((m) => m.role).join(',')}`,
})

// ---------- D07 流式中途取消 ----------
reqBase = mock.requests.length
let cancelAt = 0
let cancelled = false
r = await p.prompt('d07', '慢慢说 [[SLOW]]', {
  onEvent: (e) => {
    if (!cancelled && e.type === 'delta' && e.text.startsWith('片9')) { cancelled = true; cancelAt = Date.now(); p.cancel('d07') }
  },
})
await sleep(300)
const req07 = mock.requests[reqBase]
const proxy07 = proxy.log.find((x) => x.at >= req07.at - 5)
const am07 = r.events.find((e) => e.type === 'assistant_message')
record({
  id: 'D07', desc: '流式生成中途取消：取消 → turn_end(aborted) 的耗时、上游连接被关闭、部分内容标记 interrupted',
  detail: { cancelToTurnEndMs: r.end.at - cancelAt, reason: r.end.reason, deltasBefore: r.events.filter((e) => e.type === 'delta').length, assistantMessage: am07, upstreamClientClosedEarly: req07.clientClosedEarly, proxyUpstreamAborted: proxy07?.upstreamAborted },
  pass: r.end.reason?.kind === 'aborted' && r.end.at - cancelAt < 1000 && req07.clientClosedEarly === true && am07?.interrupted === true,
  note: `取消→turn_end ${r.end.at - cancelAt} ms，reason=${JSON.stringify(r.end.reason)}，上游连接提前关闭=${req07.clientClosedEarly}`,
})

// ---------- D08 工具执行中取消：进程组终止 ----------
let toolStartedAt = 0
cancelled = false
r = await p.prompt('d08', '跑个长命令 [[SLEEPTOOL]]', {
  onEvent: async (e) => {
    if (!cancelled && e.type === 'tool_call') {
      cancelled = true
      // 等两个 sleep 都起来
      for (let i = 0; i < 50 && (pgrep('sleep 61').length === 0 || pgrep('sleep 62').length === 0); i++) await sleep(100)
      toolStartedAt = Date.now()
      p.cancel('d08')
    }
  },
})
const endMs08 = r.end.at - toolStartedAt
await sleep(200)
const left61 = pgrep('sleep 61')
const left62 = pgrep('sleep 62')
await sleep(3500)
const left61b = pgrep('sleep 61')
const left62b = pgrep('sleep 62')
record({
  id: 'D08', desc: '工具执行中取消：前台 sleep 61 与后台孙进程 sleep 62 所在进程组被终止',
  detail: { cancelToTurnEndMs: endMs08, reason: r.end.reason, toolResult: r.events.find((e) => e.type === 'tool_result'), remainingAfter200ms: { sleep61: left61, sleep62: left62 }, remainingAfter3700ms: { sleep61: left61b, sleep62: left62b } },
  pass: r.end.reason?.kind === 'aborted' && endMs08 < 2000 && left61.length === 0,
  note: `取消→turn_end ${endMs08} ms；200 ms 后残留 sleep61=${left61.length} sleep62=${left62.length}；3.7 s 后残留 sleep61=${left61b.length} sleep62=${left62b.length}`,
})
for (const pid of [...left61b, ...left62b]) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }

// ---------- D08b 忽略 SIGTERM 的工具：宽限期后 SIGKILL ----------
cancelled = false
let cancel08b = 0
let gone08b = null
r = await p.prompt('d08b', '跑个顽固命令 [[STUBBORNTOOL]]', {
  onEvent: async (e) => {
    if (!cancelled && e.type === 'tool_call') {
      cancelled = true
      for (let i = 0; i < 50 && pgrep('sleep 63').length === 0; i++) await sleep(100)
      cancel08b = Date.now()
      p.cancel('d08b')
      for (let i = 0; i < 100; i++) { if (pgrep('sleep 63').length === 0) { gone08b = Date.now() - cancel08b; break } await sleep(20) }
    }
  },
})
await sleep(2500)
const left63 = pgrep('sleep 63')
record({
  id: 'D08b', desc: '忽略 SIGTERM 的工具（bash-sandbox.graceMs=500）：取消后多久进程组被 SIGKILL 清除',
  detail: { cancelToTurnEndMs: r.end.at - cancel08b, cancelToProcessGoneMs: gone08b, remainingAfter: left63, reason: r.end.reason, toolResult: r.events.find((e) => e.type === 'tool_result') },
  pass: r.end.reason?.kind === 'aborted' && gone08b !== null && gone08b < 1000 && left63.length === 0,
  note: `取消→turn_end ${r.end.at - cancel08b} ms；取消→sleep 63 消失 ${gone08b} ms`,
})
for (const pid of left63) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }

// ---------- D09 关闭进程 ----------
const sd = await p.shutdown()
record({ id: 'D09', desc: '关闭：IPC shutdown → 进程退出', detail: sd, pass: !sd.forced && sd.code === 0, note: `${sd.ms} ms，exit=${sd.code}` })

// ---------- D10 新进程（新 microVM）首轮注入历史上下文 ----------
const ws2 = mkdtempSync(join(tmpdir(), 'spike05-ws2-'))
const t10 = Date.now()
p = newProc({ cwd: ws2 })
const ready10 = await p.ready()
record({
  id: 'D01w', desc: '启动（DSH_HOME 已初始化，相当于镜像构建时预热）：spawn 到桥接插件就绪',
  detail: { ...ready10, spawnToReadyMs: ready10.at - t10 }, pass: ready10.type === 'ready', note: `${ready10.at - t10} ms`,
})
reqBase = mock.requests.length
r = await p.prompt('d10', '我叫什么名字？ [[TEXT]]', {
  context: [
    { role: 'user', text: '你好，我叫小明，我在做 AgentCore PoC。' },
    { role: 'assistant', text: '你好小明，有什么可以帮你？' },
  ],
})
const req10 = mock.requests[reqBase]
const users10 = req10.body.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content))
record({
  id: 'D10', desc: '新 DSH 进程首轮：agent.inject 注入的历史上下文出现在模型请求中，且位于本轮用户消息之前',
  detail: { roles: req10.body.messages.map((m) => m.role), userTexts: users10.map((t) => t.slice(0, 120)) },
  pass: users10.length >= 2 && users10.findIndex((t) => t.includes('小明')) >= 0 && users10.findIndex((t) => t.includes('小明')) < users10.findIndex((t) => t.includes('我叫什么名字')),
  note: `用户角色消息 ${users10.length} 条，上下文位于第 ${users10.findIndex((t) => t.includes('小明')) + 1} 条`,
})
await p.shutdown()

// ---------- D11 工作空间路径 / DSH_HOME 持久化 / 外联 ----------
const homeTree = listTree(dshHome)
const linkCount = homeTree.filter((x) => x.startsWith('profiles/node_modules/') && x.endsWith('(symlink)')).length
const homeSummary = homeTree.filter((x) => !x.startsWith('profiles/node_modules/'))
record({
  id: 'D11', desc: 'DSH 自身持久化只落在 DSH_HOME（会话 JSONL、设置、配置文件），不写工作空间',
  detail: { dshHome: homeSummary, profilesNodeModulesSymlinks: linkCount, workspaceTree: listTree(workspace), workspace2Tree: listTree(ws2) },
  pass: listTree(workspace).every((x) => !x.startsWith('.dsh')) && listTree(ws2).length === 0,
  note: `DSH_HOME：profiles/node_modules 下 ${linkCount} 个依赖链接，其余 ${homeSummary.length} 项（会话 JSONL、投影缓存、profile）；工作空间只有工具写入的文件`,
})
record({
  id: 'D12', desc: '外联：DSH 进程没有尝试访问任何非回环地址（遥测、DeepSeek 官方 API 等均已关闭）',
  detail: egress.attempts, pass: egress.attempts.length === 0, note: `${egress.attempts.length} 次外联尝试`,
})

writeFileSync(join(RESULTS, 'cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
writeFileSync(join(RESULTS, 'upstream-requests.jsonl'), mock.requests.map((x) => JSON.stringify({ ...x, body: { ...x.body, messages: x.body?.messages?.map((m) => ({ ...m, content: typeof m.content === 'string' ? m.content.slice(0, 400) : m.content })) } })).join('\n') + '\n')
const md = ['# Spike 05 结果摘要', '', `- DSH：@deepseek-ai/dsh@${dshVersion}；Node ${process.version} ${process.platform}-${process.arch}；运行时间 ${new Date(t0).toISOString()}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((x) => !x.pass).length}`, '', '| 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|']
for (const x of rows) md.push(`| ${x.id} | ${x.desc} | ${String(x.note ?? '').replace(/\|/g, '\\|')} | ${x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'summary.md'), md.join('\n') + '\n')

for (const s of [mock.server, proxy.server, egress.server]) s.close()
rmSync(workspace, { recursive: true, force: true })
rmSync(ws2, { recursive: true, force: true })
rmSync(dshHome, { recursive: true, force: true })
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)
process.exit(rows.some((x) => !x.pass) ? 1 : 0)

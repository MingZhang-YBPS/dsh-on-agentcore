// 真实 AWS 端到端（任务 8.1、8.2）：针对 `npm run deploy` 部署的栈 DshPoc 运行。
//   npx tsx test/e2e/cloud.ts [phase ...]      默认 E U P S K
// 阶段：
//   E  入口、鉴权、隔离、续期、插件缓存、登出（HTTP / WebSocket 直接调用，C01–C19）
//   U  浏览器：alice 完整流程（真实模型）、bob 隔离、两名用户并发对话（U01–U13、R02–R05、U10、D01）
//   P  持久化：StopRuntimeSession 后重新打开，历史与文件仍在，冷启动 ≤ 60 s（P01–P02）
//   S  页面打开时 StopRuntimeSession：自动重连、不刷新继续对话、刷新后历史可见（S01–S03）
//   K  同一会话 30 个并发请求（K01）
//   C  /plugins/* 缓存对首页加载的影响：清除缓存后连续三次在新浏览器上下文中登录加载（C20–C23，任务 6.3）
//   L  页面保持 HOLD_MIN（默认 70）分钟：AgentCore 1 小时关闭 WebSocket 后自动重连并继续对话（L01–L03）
//   G  插件设置页（模型设置页不出现）与网页搜索：部署配置了 DeepSeek key 时让真实模型调用 web_search（G01–G07）
//   M  maxLifetime 到期回收（需要以 -c maxLifetimeSeconds=300 部署；否则跳过）（M01–M02）
// 用户：demoUsers 中的 alice、bob、carol、dave、erin（口令从栈输出的 Secret 读取）；运维用户 ops 用于 StopRuntimeSession。
// 用例可重复运行：每次运行生成新的 runId，提示词与文件内容都带 runId。
// 结果：test/e2e/results/<phase>-cases.jsonl 与 summary-<phase>.md；截图与原始 JSON 在 test/results/e2e/。

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { REPO } from '../integration/harness/local-env.js'
import { WIN_UI_DIR, runWindowsUi, windowsUiAvailable, type UiCase, type UiResult } from '../integration/harness/windows-ui.js'

const exec = promisify(execFile)
const RESULTS = join(REPO, 'test', 'e2e', 'results')
const RAW = join(REPO, 'test', 'results', 'e2e')
mkdirSync(RESULTS, { recursive: true })
mkdirSync(RAW, { recursive: true })
const PHASES = process.argv.slice(2).length ? process.argv.slice(2) : ['E', 'U', 'P', 'S', 'K']
const HOLD_MIN = Number(process.env.HOLD_MIN ?? 70)
const runId = randomBytes(3).toString('hex')
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Row { id: string; desc: string; pass?: boolean; note?: string; [k: string]: unknown }
let rows: Row[] = []
const record = (r: Row) => { rows.push(r); log(`${r.pass === undefined ? '•' : r.pass ? '✓' : '✗'} ${r.id} ${r.desc} — ${r.note ?? ''}`) }

// 失败时只报告子命令与 stderr 的错误行：命令行里可能有口令
async function aws<T = unknown>(...args: string[]): Promise<T> {
  try {
    const { stdout } = await exec('aws', [...args, '--output', 'json'], { maxBuffer: 1 << 26 })
    return (stdout.trim() ? JSON.parse(stdout) : null) as T
  } catch (e) {
    const err = (e as { stderr?: string }).stderr ?? ''
    // eslint-disable-next-line preserve-caught-error -- 原始错误的 cmd 字段含口令，故意不附带 cause
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${(err.split('\n').find((l) => /error/i.test(l)) ?? '').slice(0, 200)}`)
  }
}

// ---------- 部署信息 ----------
const stack = (await aws<{ Stacks: { Outputs: { OutputKey: string; OutputValue: string }[] }[] }>('cloudformation', 'describe-stacks', '--stack-name', 'DshPoc')).Stacks[0]
const out = Object.fromEntries((stack?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])) as Record<string, string>
const CF = (out.WebUrl ?? '').replace(/\/$/, '')
const CF_HOST = new URL(CF).host
const REGION = (out.AgentRuntimeArn ?? '').split(':')[3] ?? 'us-east-1'
const RUNTIME_ARN = out.AgentRuntimeArn ?? ''
const RUNTIME_ID = out.AgentRuntimeId ?? ''
const LOG_GROUP = `/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT`
const FN_URL = (await aws<{ FunctionUrl: string }>('lambda', 'get-function-url-config', '--function-name', out.TunnelFunctionName ?? '')).FunctionUrl
const INVOKE_URL = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`
const WS_URL = (sid: string) => `wss://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(RUNTIME_ARN)}/ws?qualifier=DEFAULT&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${sid}`
log(`runId ${runId}；${CF}；Runtime ${RUNTIME_ID} v${out.AgentRuntimeVersion}；模型 ${out.EffectiveModelId}；阶段 ${PHASES.join(' ')}`)

const passwords: Record<string, string> = {}
async function password(user: string): Promise<string> {
  const arn = out[`UserSecret${user}`]
  if (!arn) throw new Error(`user ${user} is not deployed (add it to -c demoUsers=...)`)
  passwords[user] ??= (await aws<{ SecretString: string }>('secretsmanager', 'get-secret-value', '--secret-id', arn)).SecretString
  return passwords[user]
}
interface Tok { tok: string; refresh: string; sub: string; username: string; exp: number; sid: string }
async function tokenOf(user: string): Promise<Tok> {
  const r = await aws<{ AuthenticationResult: { AccessToken: string; RefreshToken: string } }>('cognito-idp', 'admin-initiate-auth', '--user-pool-id', out.UserPoolId ?? '', '--client-id', out.UserPoolClientId ?? '',
    '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', JSON.stringify({ USERNAME: user, PASSWORD: await password(user) }))
  const tok = r.AuthenticationResult.AccessToken
  const p = JSON.parse(Buffer.from(tok.split('.')[1] ?? '', 'base64url').toString()) as { sub: string; username: string; exp: number }
  return { tok, refresh: r.AuthenticationResult.RefreshToken, sub: p.sub, username: p.username, exp: p.exp * 1000, sid: `dsh-user-${p.sub}` }
}
const cookieOf = (t: Tok, withRefresh = false) => `dsh_token=${t.tok}${withRefresh ? `; dsh_refresh=${t.refresh}` : ''}`

/** 运行 Windows 侧浏览器脚本；凭证写入临时文件，运行后删除 */
async function ui(script: string, user: string, outName: string, args: string[], timeoutMs = 1_200_000, extra?: unknown): Promise<UiResult & Record<string, unknown>> {
  const cred = `creds-${outName}.json`
  writeFileSync(join(WIN_UI_DIR, cred), JSON.stringify({ username: user, password: await password(user) }))
  const extraFile = `extra-${outName}.json`
  if (extra !== undefined) writeFileSync(join(WIN_UI_DIR, extraFile), JSON.stringify(extra))
  try {
    return (await runWindowsUi(script, [`${CF}/`, ...args.map((a) => a.replace('{cred}', cred).replace('{extra}', extraFile))], outName, RAW, timeoutMs)) as UiResult & Record<string, unknown>
  } finally {
    rmSync(join(WIN_UI_DIR, cred), { force: true })
    rmSync(join(WIN_UI_DIR, extraFile), { force: true })
  }
}
// E2E_ONLY=U02,U13 只运行列出的浏览器用例（排障用）
const ONLY = process.env.E2E_ONLY ?? ''
const cloudSuite = (user: string, phase: string, outName: string, extra?: unknown) =>
  ui('cloud-suite.mjs', user, outName, [phase, outName, '{cred}', runId, extra !== undefined ? '{extra}' : '-', ...(ONLY ? [ONLY] : [])], 1_800_000, extra)
const addUiCases = (res: UiResult, user: string) => { for (const c of res.cases as UiCase[]) record({ ...c, user }) }

// Runtime 配置了 JWT 授权器，StopRuntimeSession 也必须用 Bearer 令牌（SigV4 返回 Authorization method mismatch）
async function stopSession(sid: string): Promise<string> {
  const ops = await tokenOf('ops')
  const r = await fetch(`https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(RUNTIME_ARN)}/stopruntimesession?qualifier=DEFAULT`, {
    method: 'POST', headers: { authorization: `Bearer ${ops.tok}`, 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': sid }, body: '{}',
  })
  return `${r.status} ${(await r.text()).slice(0, 120)}`
}
async function adapterLogs(sinceMs: number, pattern: string): Promise<{ t: string; m: Record<string, unknown> }[]> {
  try {
    const r = await aws<{ events: { timestamp: number; message: string }[] }>('logs', 'filter-log-events', '--log-group-name', LOG_GROUP, '--start-time', String(sinceMs), '--filter-pattern', pattern)
    return r.events.map((e) => { let m: Record<string, unknown>; try { m = JSON.parse(e.message) as Record<string, unknown> } catch { m = { raw: e.message.slice(0, 200) } } return { t: new Date(e.timestamp).toISOString().slice(11, 19), m } })
  } catch (e) { return [{ t: '', m: { error: (e as Error).message.slice(0, 120) } }] }
}

// 用静态资源 /favicon.svg 做探针：内层 200 只取决于会话归属校验是否放行
async function directInvoke(tok: string | null, sid: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/octet-stream', 'x-amzn-bedrock-agentcore-runtime-session-id': sid }
  if (tok) headers.authorization = `Bearer ${tok}`
  const r = await fetch(INVOKE_URL, { method: 'POST', headers, body: JSON.stringify({ v: 1, method: 'GET', path: '/favicon.svg', headers: {}, body: null }) })
  const buf = Buffer.from(await r.arrayBuffer())
  const nl = buf.indexOf(0x0a)
  let inner: number | null = null
  try { inner = nl > 0 ? (JSON.parse(buf.subarray(0, nl).toString()) as { status: number }).status : null } catch { /* 非封包响应 */ }
  return { status: r.status, inner, body: buf.subarray(0, 160).toString() }
}
function wsProbe(url: string, headers: Record<string, string>): Promise<{ result: string; status?: number; code?: number; error?: string }> {
  return new Promise((res) => {
    const ws = new WebSocket(url, { headers })
    const t = setTimeout(() => { ws.terminate(); res({ result: 'timeout' }) }, 30000)
    ws.on('open', () => { setTimeout(() => { clearTimeout(t); res({ result: ws.readyState === WebSocket.OPEN ? 'open' : 'closed-after-open' }); ws.terminate() }, 3000) })
    ws.on('unexpected-response', (_q, r) => { clearTimeout(t); res({ result: 'rejected', status: r.statusCode }) })
    ws.on('close', (code) => { clearTimeout(t); res({ result: 'closed', code }) })
    ws.on('error', (e) => { clearTimeout(t); res({ result: 'error', error: e.message }) })
  })
}
const setCookies = (r: Response) => r.headers.getSetCookie()

function finish(phase: string) {
  writeFileSync(join(RESULTS, `${phase}-cases.jsonl`), rows.map((x) => JSON.stringify({ runId, ...x })).join('\n') + '\n')
  const md = [`# 端到端阶段 ${phase} 结果`, '', `- 运行：${new Date().toISOString()}；runId ${runId}；${CF}；Runtime ${RUNTIME_ID} v${out.AgentRuntimeVersion}；模型 ${out.EffectiveModelId}`,
    `- 用例 ${rows.filter((x) => x.pass !== undefined).length}，不符合预期 ${rows.filter((x) => x.pass === false).length}`, '', '| 用例 | 用户 | 说明 | 结果 | 符合 |', '|---|---|---|---|---|']
  for (const x of rows) md.push(`| ${x.id} | ${String(x.user ?? '')} | ${x.desc} | ${String(x.note ?? x.error ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} | ${x.pass === undefined ? '记录' : x.pass ? '✓' : '✗'} |`)
  writeFileSync(join(RESULTS, `summary-${phase}.md`), md.join('\n') + '\n')
  appendFileSync(join(RESULTS, 'history.log'), `${new Date().toISOString()} ${runId} ${phase}${ONLY ? `(only ${ONLY})` : ''} ${rows.filter((x) => x.pass === false).map((x) => x.id).join(',') || 'all pass'}\n`)
  const failed = rows.filter((x) => x.pass === false).length
  rows = []
  return failed
}

let failures = 0
if (PHASES.some((p) => 'USLMPGC'.includes(p)) && !windowsUiAvailable()) throw new Error(`browser suites need playwright-core in ${WIN_UI_DIR}`)

// ================= E：入口、鉴权、隔离 =================
if (PHASES.includes('E')) {
  let r = await fetch(`${CF}/`, { redirect: 'manual' })
  record({ id: 'C01', desc: '未登录访问 / → 303 跳转登录页', pass: r.status === 303 && r.headers.get('location') === '/auth/login', note: `${r.status} → ${r.headers.get('location')}` })
  r = await fetch(`${CF}/auth/login`, { method: 'POST', body: new URLSearchParams({ username: 'alice', password: 'wrong-password-1A!' }), redirect: 'manual' })
  record({ id: 'C02', desc: '口令错误 → 401 登录页，不下发 cookie', pass: r.status === 401 && setCookies(r).length === 0, note: `${r.status}，Set-Cookie ${setCookies(r).length}` })
  r = await fetch(FN_URL, { redirect: 'manual' })
  record({ id: 'C03', desc: '绕过 CloudFront 直连 Lambda Function URL（无源站密钥）→ 403', pass: r.status === 403, note: `${r.status}` })
  r = await fetch(`${CF}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  record({ id: 'C04', desc: '未登录调用 /api/* → 401', pass: r.status === 401, note: `${r.status}` })
  const w0 = await wsProbe(`wss://${CF_HOST}/api/remote.mux`, {})
  record({ id: 'C05', desc: '未登录连接 /api/remote.mux → CloudFront Function 返回 401', pass: w0.result === 'rejected' && w0.status === 401, note: JSON.stringify(w0) })
  const t0 = Date.now()
  r = await fetch(`${CF}/auth/login`, { method: 'POST', body: new URLSearchParams({ username: 'alice', password: await password('alice') }), redirect: 'manual' })
  const sc = setCookies(r)
  record({ id: 'C06', desc: '正确口令 → 303 /，下发 HttpOnly 的 dsh_token 与 dsh_refresh', pass: r.status === 303 && sc.some((c) => /^dsh_token=.+HttpOnly/.test(c)) && sc.some((c) => /^dsh_refresh=.+HttpOnly/.test(c)), note: `${r.status} ${Date.now() - t0} ms；${sc.map((c) => c.split('=')[0]).join(', ')}` })

  const alice = await tokenOf('alice')
  const bob = await tokenOf('bob')
  let d = await directInvoke(bob.tok, alice.sid)
  record({ id: 'C07', desc: 'bob 的有效令牌 + alice 的会话 ID 直接调用 AgentCore → 适配器 403', pass: d.inner === 403, note: `AgentCore ${d.status}，内层 ${d.inner}` })
  d = await directInvoke(alice.tok, alice.sid)
  record({ id: 'C08', desc: '对照：alice 令牌 + alice 会话 ID → 200', pass: d.status === 200 && d.inner === 200, note: `AgentCore ${d.status}，内层 ${d.inner}` })
  d = await directInvoke(null, alice.sid)
  record({ id: 'C09', desc: '不带令牌直接调用 AgentCore → JWT 授权器拒绝', pass: d.status === 401 || d.status === 403, note: `${d.status}` })
  const forgedSig = alice.tok.slice(0, -4) + (alice.tok.endsWith('AAAA') ? 'BBBB' : 'AAAA')
  d = await directInvoke(forgedSig, alice.sid)
  record({ id: 'C10', desc: '签名被篡改的令牌 → JWT 授权器拒绝', pass: d.status === 401 || d.status === 403, note: `${d.status}` })
  let w = await wsProbe(WS_URL(alice.sid), { Authorization: `Bearer ${bob.tok}` })
  record({ id: 'C11', desc: 'bob 令牌 + alice 会话 ID 直连 AgentCore /ws → 被拒绝或立即关闭', pass: w.result !== 'open', note: JSON.stringify(w) })
  w = await wsProbe(WS_URL(alice.sid), { Authorization: `Bearer ${alice.tok}` })
  record({ id: 'C12', desc: '对照：alice 令牌 + alice 会话 ID 直连 /ws → 保持打开', pass: w.result === 'open', note: JSON.stringify(w) })
  w = await wsProbe(WS_URL(alice.sid), {})
  record({ id: 'C13', desc: '不带令牌直连 /ws → 被拒绝', pass: w.result === 'rejected' || w.result === 'error', note: JSON.stringify(w) })
  record({ id: 'C14', desc: '会话 ID 由令牌主体派生，两名用户互不相同', pass: alice.sid !== bob.sid, note: `alice=${alice.sid} bob=${bob.sid}` })
  w = await wsProbe(WS_URL(alice.sid), { authorization: `Bearer ${alice.tok}` })
  record({ id: 'C15', desc: '记录行为：直连 /ws 时小写 authorization 不会被转发给容器 → 424', pass: w.result === 'rejected' && w.status === 424, note: JSON.stringify(w) })

  // C16：过期令牌 + 有效刷新令牌 → 隧道续期后转发成功，并下发新的 dsh_token
  const [h, p] = alice.tok.split('.')
  const expiredPayload = { ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString()), exp: Math.floor(Date.now() / 1000) - 60 }
  const expired = `${h}.${Buffer.from(JSON.stringify(expiredPayload)).toString('base64url')}.x`
  r = await fetch(`${CF}/`, { headers: { cookie: `dsh_token=${expired}; dsh_refresh=${alice.refresh}` }, redirect: 'manual' })
  const renewed = setCookies(r).find((c) => c.startsWith('dsh_token='))
  record({ id: 'C16', desc: '访问令牌已过期 + 有效刷新令牌 → 隧道续期后转发成功，并下发新 dsh_token', pass: r.status === 200 && Boolean(renewed), note: `${r.status}；新 cookie=${Boolean(renewed)}` })
  r = await fetch(`${CF}/`, { headers: { cookie: `dsh_token=${expired}` }, redirect: 'manual' })
  record({ id: 'C17', desc: '访问令牌已过期且没有刷新令牌 → 页面导航清 cookie 跳登录页', pass: r.status === 303 && r.headers.get('location') === '/auth/login', note: `${r.status} → ${r.headers.get('location')}` })

  // C18：/plugins/* 缓存行为（URL 取自首页 HTML；若首页没有直接引用插件包，则由 U01 的浏览器记录覆盖）
  const html = await (await fetch(`${CF}/`, { headers: { cookie: cookieOf(alice) } })).text()
  const m = /["'](\/plugins\/[^"']+)["']/.exec(html)
  if (m?.[1]) {
    const pu = `${CF}${m[1].replace(/&amp;/g, '&')}`
    const r1 = await fetch(pu, { headers: { cookie: cookieOf(alice) } })
    await r1.arrayBuffer()
    const r2 = await fetch(pu, { headers: { cookie: cookieOf(bob) } })
    await r2.arrayBuffer()
    const r3 = await fetch(pu)
    record({ id: 'C18', desc: '/plugins/*：第二次请求命中缓存（另一用户），不带 Set-Cookie；不带 cookie → 401', pass: r2.status === 200 && /Hit/i.test(r2.headers.get('x-cache') ?? '') && setCookies(r1).length === 0 && setCookies(r2).length === 0 && r3.status === 401, note: `${m[1].slice(0, 60)}：${r1.status} ${r1.headers.get('x-cache')} / ${r2.status} ${r2.headers.get('x-cache')} / 无 cookie ${r3.status}` })
  } else record({ id: 'C18', desc: '/plugins/* 缓存行为', note: '首页 HTML 未直接引用插件包，见 U01 的浏览器记录' })

  // C19：登出（用 erin，避免让其他用户的刷新令牌失效）
  const erin = await tokenOf('erin')
  r = await fetch(`${CF}/auth/logout`, { headers: { cookie: cookieOf(erin, true) }, redirect: 'manual' })
  const cleared = setCookies(r).filter((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)).length
  const [eh, ep] = erin.tok.split('.')
  const erinExpired = `${eh}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(ep ?? '', 'base64url').toString()), exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')}.x`
  const r2 = await fetch(`${CF}/`, { headers: { cookie: `dsh_token=${erinExpired}; dsh_refresh=${erin.refresh}` }, redirect: 'manual' })
  record({ id: 'C19', desc: '登出：303 登录页并清除两个 cookie；刷新令牌随 GlobalSignOut 失效', pass: r.status === 303 && cleared === 2 && r2.status === 303, note: `${r.status} → ${r.headers.get('location')}，清除 ${cleared} 个 cookie；登出后用刷新令牌续期 → ${r2.status} ${r2.headers.get('location')}` })
  failures += finish('E')
}

// ================= U：浏览器 =================
if (PHASES.includes('U')) {
  // 回收 alice 的 microVM：保证用例运行在当前 Runtime 版本上（默认模型在 microVM 启动时确定）
  record({ id: 'U00', desc: '回收 alice 的 microVM（StopRuntimeSession）', note: await stopSession((await tokenOf('alice')).sid) })
  await sleep(10000)
  const a = await cloudSuite('alice', 'A', `U-A-alice-${runId}`)
  addUiCases(a, 'alice')
  // alice 的所有提示词（因而会话标题）都以 e2e-<runId>-alice 开头；工具写入的文件内容是 dsh-e2e-<runId>
  const forbidden = [`e2e-${runId}-alice`, `dsh-e2e-${runId}`, `pong-${runId}alice`, `${runId}alice`.toUpperCase()]
  const i = await cloudSuite('bob', 'I', `U-I-bob-${runId}`, { forbidden })
  addUiCases(i, 'bob')
  const [da, db] = await Promise.all([cloudSuite('alice', 'D', `U-D-alice-${runId}`), cloudSuite('bob', 'D', `U-D-bob-${runId}`)])
  addUiCases(da, 'alice')
  addUiCases(db, 'bob')
  // U16：bob 从未切换过模型，他的新会话使用部署的默认模型
  const bobModel = (db.cases as (UiCase & { model?: string })[]).find((c) => c.id === 'D01')?.model
  const keyArn = out.DeepSeekApiKeySecretArn
  const keyStored = keyArn ? (await aws<{ SecretString: string }>('secretsmanager', 'get-secret-value', '--secret-id', keyArn)).SecretString : ''
  const expectModel = keyStored && keyStored !== 'not-configured' ? 'DeepSeek-V4.1-Flash' : 'deepseek.v3.2'
  record({ id: 'U16', desc: '未切换过模型的用户，新会话使用部署的默认模型（配置了 DeepSeek key 时为 DeepSeek-V4.1-Flash）', pass: bobModel === expectModel, note: `bob 新会话「${bobModel}」，期望「${expectModel}」`, user: 'bob' })
  const again = await cloudSuite('bob', 'I', `U-I2-bob-${runId}`, { forbidden })
  for (const c of again.cases as UiCase[]) record({ ...c, id: 'U10b', desc: '并发对话之后再次检查：bob 仍看不到 alice 的内容', user: 'bob' })
  failures += finish('U')
}

// ================= P：持久化 =================
if (PHASES.includes('P')) {
  const w = await cloudSuite('alice', 'W', `P-W-alice-${runId}`)
  addUiCases(w, 'alice')
  const alice = await tokenOf('alice')
  const since = Date.now()
  const stop = await stopSession(alice.sid)
  record({ id: 'P0S', desc: 'StopRuntimeSession（运维用户的 Bearer 令牌）', pass: stop.startsWith('200'), note: stop })
  await sleep(15000)
  const res = await cloudSuite('alice', 'P', `P-alice-${runId}`, { title: `e2e-${runId}-alice 请调用`, marker: `dsh-e2e-${runId}` })
  addUiCases(res, 'alice')
  await sleep(10000)
  // 逐个模式查询（带空格的短语用 ? 组合时实测会漏掉事件）
  const ready = (await Promise.all(['"final home mirror sync"', '"home restore"', '"dsh web ready"'].map((q) => adapterLogs(since, q)))).flat().sort((x, y) => x.t.localeCompare(y.t))
  const r0 = ready.find((e) => e.m.msg === 'dsh web ready')
  record({ id: 'P04', desc: '新 microVM：DSH_HOME 从 session storage 恢复，适配器启动到 DSH 就绪的耗时', pass: Boolean(r0) && Number(r0?.m.readyMs) <= 60000, note: ready.map((e) => `${e.t} ${String(e.m.msg)} ${JSON.stringify({ readyMs: e.m.readyMs, restored: e.m.restored, copied: e.m.copied, ms: e.m.ms })}`).join('；').slice(0, 280) })
  failures += finish('P')
}

// ================= S：页面打开时回收 =================
async function watchWithTrigger(user: string, outName: string, minutes: number, trigger: () => Promise<string>) {
  rmSync(join(WIN_UI_DIR, `${outName}.go`), { force: true })
  const p = ui('long.mjs', user, outName, ['watch', outName, '{cred}', String(minutes), 'real'], (minutes + 25) * 60000)
  const t0 = Date.now()
  while (Date.now() - t0 < 600000) { if (await import('node:fs').then((fs) => fs.existsSync(join(WIN_UI_DIR, `${outName}-ready.png`)))) break; await sleep(2000) }
  await sleep(5000)
  const note = await trigger()
  writeFileSync(join(WIN_UI_DIR, `${outName}.go`), '')
  const res = await p
  rmSync(join(WIN_UI_DIR, `${outName}.go`), { force: true })
  return { res: res as unknown as { timeline: Record<string, unknown>[] }, note }
}
function recycleCases(prefix: string, res: { timeline: Record<string, unknown>[] }, trigger: string) {
  const tl = res.timeline ?? []
  const go = Number(tl.find((e) => e.kind === 'state' && e.tag === 'ready')?.t ?? 0)
  const end = Number(tl.find((e) => e.kind === 'state' && e.tag === 'after-send-no-reload')?.t ?? Infinity)
  const win = tl.filter((e) => Number(e.t) >= go && Number(e.t) <= end)
  const closes = win.filter((e) => e.kind === 'ws-close').map((e) => `#${String(e.id)}@${String(e.t)}s`)
  const opens = win.filter((e) => e.kind === 'ws-open').map((e) => `#${String(e.id)}@${String(e.t)}s`)
  const reply = (tag: string) => tl.find((e) => e.kind === 'reply' && e.tag === tag) as { ok?: boolean; ms?: number; error?: string } | undefined
  const noReload = reply('回收之后不刷新')
  const afterReload = reply('刷新之后')
  const hist = tl.find((e) => e.kind === 'history-after-reload') as { visible?: boolean } | undefined
  record({ id: `${prefix}1`, desc: '回收后打开着的页面：WebSocket 关闭并自动重连（刷新前）', pass: closes.length >= 1 && opens.length >= 1, note: `${trigger}；关闭 ${closes.join(' ') || '无'}，新开 ${opens.join(' ') || '无'}` })
  record({ id: `${prefix}2`, desc: '回收后不刷新页面继续对话', pass: Boolean(noReload?.ok), note: noReload ? `${noReload.ok ? 'ok' : 'FAIL'} ${noReload.ms} ms ${noReload.error ?? ''}` : '无记录' })
  record({ id: `${prefix}3`, desc: '回收后刷新页面：历史可见、可继续对话', pass: Boolean(afterReload?.ok && hist?.visible), note: `历史=${hist?.visible}；回复 ${afterReload?.ok ? `ok ${afterReload.ms} ms` : `FAIL ${afterReload?.error ?? ''}`}` })
}
if (PHASES.includes('S')) {
  const carol = await tokenOf('carol')
  const { res, note } = await watchWithTrigger('carol', `S-carol-${runId}`, 3, async () => `StopRuntimeSession ${await stopSession(carol.sid)}`)
  recycleCases('S0', res, note)
  failures += finish('S')
}

// ================= K：同一会话 30 个并发请求 =================
if (PHASES.includes('K')) {
  const alice = await tokenOf('alice')
  const t0 = Date.now()
  const reqs = Array.from({ length: 30 }, (_, i) => (i % 2 === 0
    ? fetch(`${CF}/`, { headers: { cookie: cookieOf(alice) } })
    : fetch(`${CF}/favicon.svg?k=${i}`, { headers: { cookie: cookieOf(alice) } })).then(async (r) => { await r.arrayBuffer(); return r.status }, (e: Error) => e.message))
  const statuses = await Promise.all(reqs)
  const ok = statuses.filter((s) => s === 200).length
  record({ id: 'K01', desc: '同一会话 30 个并发 HTTP 请求（首页与静态资源）全部成功', pass: ok === 30, note: `${ok}/30 成功，${Date.now() - t0} ms；${[...new Set(statuses)].join(',')}` })
  failures += finish('K')
}

// ================= G：插件设置页与网页搜索 =================
if (PHASES.includes('G')) {
  const arn = out.DeepSeekApiKeySecretArn
  const stored = arn ? (await aws<{ SecretString: string }>('secretsmanager', 'get-secret-value', '--secret-id', arn)).SecretString : ''
  const keyConfigured = Boolean(stored && stored !== 'not-configured')
  // 卡片的「已配置密钥」状态与 Runtime 版本都在 microVM 启动时确定：先回收该用户的 microVM，保证用例运行在当前配置上
  const carol = await tokenOf('carol')
  record({ id: 'G00', desc: '回收测试用户的 microVM（StopRuntimeSession），使用当前版本与当前 key 状态启动', note: await stopSession(carol.sid) })
  await sleep(10000)
  const outName = `G-carol-${runId}`
  const r = await ui('plugins-suite.mjs', 'carol', outName, [outName, '{cred}', keyConfigured ? 'real' : 'skip', runId], 1_200_000)
  addUiCases(r, 'carol')
  if (!keyConfigured) record({ id: 'G07', desc: '对话中调用 web_search', note: '跳过：部署没有配置 DeepSeek API key（DEEPSEEK_API_KEY=... npm run deploy）' })
  const g03 = (r.cases as UiCase[]).find((c) => c.id === 'G03') as (UiCase & { configured?: boolean }) | undefined
  record({ id: 'G08', desc: '网页搜索卡片的「已配置密钥」与部署的 secret 一致', pass: g03?.configured === keyConfigured, note: `secret ${keyConfigured ? '已配置' : '未配置'}，卡片 ${g03?.configured ? '已配置' : '未配置'}（卡片状态在 microVM 启动时确定）` })
  failures += finish('G')
}

// ================= C：/plugins/* 缓存对首页加载的影响（任务 6.3） =================
if (PHASES.includes('C')) {
  const inv = await aws<{ Invalidation: { Id: string } }>('cloudfront', 'create-invalidation', '--distribution-id', out.DistributionId ?? '', '--paths', '/plugins/*')
  await exec('aws', ['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', out.DistributionId ?? '', '--id', inv.Invalidation.Id], { timeout: 900000 })
  const runs: { loginMs: number; hits: number; total: number }[] = []
  for (let i = 0; i < 3; i++) {
    const r = await cloudSuite('carol', 'T', `C-carol-${runId}-${i}`)
    const c = (r.cases as UiCase[])[0] as UiCase & { loginMs: number; hits: number; total: number }
    runs.push(c)
    record({ id: `C2${i}`, desc: i === 0 ? '清除 /plugins/* 缓存后首次加载（未命中）' : `再次加载（新浏览器上下文，第 ${i + 1} 次）`, note: c.note ?? c.error, user: 'carol' })
  }
  const [miss, ...hit] = runs
  record({ id: 'C23', desc: '缓存预热后插件请求全部命中；对比首页加载耗时（需求 3.2：≤ 15 s）', pass: hit.every((h) => h.hits === h.total && h.total > 0) && runs.every((r) => r.loginMs <= 15000), note: `未命中 ${miss?.loginMs} ms（命中 ${miss?.hits}/${miss?.total}）；命中 ${hit.map((h) => `${h.loginMs} ms（${h.hits}/${h.total}）`).join('、')}` })
  failures += finish('C')
}

// ================= L：页面保持超过 1 小时 =================
if (PHASES.includes('L')) {
  const res = (await ui('long.mjs', 'dave', `L-dave-${runId}`, ['hold', `L-dave-${runId}`, '{cred}', String(HOLD_MIN), 'real'], (HOLD_MIN + 25) * 60000)) as unknown as { timeline: Record<string, unknown>[] }
  const tl = res.timeline ?? []
  const closes = tl.filter((e) => e.kind === 'ws-close')
  const opens = tl.filter((e) => e.kind === 'ws-open')
  const reply = tl.find((e) => e.kind === 'reply' && e.tag === '保持之后不刷新') as { ok?: boolean; ms?: number } | undefined
  const reconnected = closes.every((c) => opens.some((o) => Number(o.t) >= Number(c.t)))
  record({ id: 'L01', desc: `页面保持 ${HOLD_MIN} 分钟：记录 WebSocket 关闭（AgentCore 1 小时上限）`, note: `关闭 ${closes.map((c) => `#${String(c.id)}@${String(c.t)}s(${String(c.lifetimeS)}s)`).join(' ') || '无'}；打开 ${opens.map((o) => `#${String(o.id)}@${String(o.t)}s`).join(' ')}` })
  record({ id: 'L02', desc: '每次关闭之后页面都自动重新连接', pass: reconnected, note: `关闭 ${closes.length}，打开 ${opens.length}` })
  record({ id: 'L03', desc: `保持 ${HOLD_MIN} 分钟后不刷新直接对话`, pass: Boolean(reply?.ok), note: reply ? `${reply.ok ? 'ok' : 'FAIL'} ${reply.ms} ms` : '无记录' })
  failures += finish('L')
}

// ================= M：maxLifetime 到期 =================
if (PHASES.includes('M')) {
  const rt = await aws<{ lifecycleConfiguration: { maxLifetime: number } }>('bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', RUNTIME_ID)
  const maxLifetime = rt.lifecycleConfiguration.maxLifetime
  if (maxLifetime > 600) {
    record({ id: 'M00', desc: 'maxLifetime 到期回收', note: `跳过：当前 maxLifetime=${maxLifetime} s（需要以 -c maxLifetimeSeconds=300 -c idleRuntimeSessionTimeoutSeconds=240 部署）` })
  } else {
    const minutes = Math.ceil(maxLifetime / 60) + 2
    const { res, note } = await watchWithTrigger('dave', `M-dave-${runId}`, minutes, async () => `等待 maxLifetime=${maxLifetime} s 到期（观察 ${minutes} 分钟）`)
    recycleCases('M0', res, note)
  }
  failures += finish('M')
}

log(`done：${failures} 个用例不符合预期`)
process.exit(failures ? 1 : 0)

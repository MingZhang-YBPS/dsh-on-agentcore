// 阶段 3 用例编排：浏览器 → CloudFront → 隧道 Lambda（HTTP，Cognito 令牌 cookie）/ AgentCore /ws（CloudFront Function 注入 Bearer）
// → AgentCore Runtime（JWT 授权器）→ 适配器（会话归属校验）→ dsh web。
// 前置：aws/build.sh、aws/setup.sh、cloud/setup.sh 已执行。结果：results/cloud-*.json、results/cloud-summary.md

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(SPIKE_DIR, 'results')
mkdirSync(RESULTS, { recursive: true })
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')]))
const st = readEnv(join(SPIKE_DIR, '.state', 'state.env'))
const sec = readEnv(join(SPIKE_DIR, '.state', 'cloud-secrets.env'))
const CF = `https://${st.DIST_DOMAIN}`
const region = st.REGION
const INVOKE_URL = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(st.RUNTIME_ARN)}/invocations?qualifier=DEFAULT`
const WS_URL = (sid) => `wss://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(st.RUNTIME_ARN)}/ws?qualifier=DEFAULT&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${sid}`
const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike06-ui'
const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
cpSync(join(SPIKE_DIR, 'ui', 'ui-suite.mjs'), join(WIN_UI_DIR, 'ui-suite.mjs'))
const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.id} ${r.desc}${r.note ? ` — ${r.note}` : ''}`) }

function token(user) {
  const out = execFileSync('aws', ['cognito-idp', 'admin-initiate-auth', '--user-pool-id', st.POOL_ID, '--client-id', st.CLIENT_ID,
    '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${user},PASSWORD=${sec[`PASS_${user.toUpperCase()}`]}`,
    '--query', 'AuthenticationResult.AccessToken', '--output', 'text'], { encoding: 'utf8' })
  return out.trim()
}
const sidOf = (tok) => `dsh-user-${JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub}`

async function runUi(phase, user) {
  const out = `cloud-${phase}-${user}`
  const credFile = join(WIN_UI_DIR, `creds-${user}.json`)
  writeFileSync(credFile, JSON.stringify({ username: user, password: sec[`PASS_${user.toUpperCase()}`] }))
  try {
    const { stdout } = await promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node ui-suite.mjs ${CF}/ ${phase} ${out} hardened creds-${user}.json`], { timeout: 600000 })
    process.stdout.write(stdout)
  } catch (e) { process.stdout.write(e.stdout ?? '') } finally { rmSync(credFile, { force: true }) }
  const res = JSON.parse(readFileSync(join(WIN_UI_DIR, `${out}.json`), 'utf8'))
  for (const c of res.cases) {
    rows.push({ ...c, phase, user })
    const png = join(WIN_UI_DIR, `${out}-${c.id}.png`)
    if (existsSync(png)) cpSync(png, join(RESULTS, `${out}-${c.id}.png`))
  }
  writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 2))
  return res
}

// 用静态资源 /favicon.svg 做探针：它不需要 DSH 令牌 cookie，内层 200 只取决于会话归属校验是否放行
async function directInvoke(tok, sid) {
  const headers = { 'content-type': 'application/json', accept: 'application/octet-stream', 'x-amzn-bedrock-agentcore-runtime-session-id': sid }
  if (tok) headers.authorization = `Bearer ${tok}`
  const r = await fetch(INVOKE_URL, { method: 'POST', headers, body: JSON.stringify({ v: 1, method: 'GET', path: '/favicon.svg', headers: {}, body: null }) })
  const buf = Buffer.from(await r.arrayBuffer())
  const nl = buf.indexOf(0x0a)
  let inner = null
  try { inner = nl > 0 ? JSON.parse(buf.subarray(0, nl).toString()).status : null } catch { /* 非封包响应 */ }
  return { status: r.status, innerStatus: inner, body: buf.subarray(0, 200).toString() }
}

function directWs(url, headers) {
  return new Promise((res) => {
    const ws = new WebSocket(url, { headers })
    const t = setTimeout(() => { ws.terminate(); res({ result: 'timeout' }) }, 20000)
    ws.on('open', () => {
      // AgentCore 先完成升级再把连接交给容器；适配器拒绝时会立刻关闭
      setTimeout(() => { clearTimeout(t); res({ result: ws.readyState === WebSocket.OPEN ? 'open' : 'closed-after-open' }); ws.terminate() }, 3000)
    })
    ws.on('unexpected-response', (_q, r) => { clearTimeout(t); res({ result: 'rejected', status: r.statusCode }) })
    ws.on('close', (code) => { clearTimeout(t); res({ result: 'closed', code }) })
    ws.on('error', (e) => { clearTimeout(t); res({ result: 'error', error: e.message }) })
  })
}

// ---------- 入口与鉴权 ----------
let r = await fetch(`${CF}/`, { redirect: 'manual' })
record({ id: 'C01', desc: '未登录访问 / → 303 跳转登录页', pass: r.status === 303 && r.headers.get('location') === '/auth/login', note: `${r.status} → ${r.headers.get('location')}` })
r = await fetch(`${CF}/auth/login`, { method: 'POST', body: new URLSearchParams({ username: 'alice', password: 'wrong-password-1A!' }), redirect: 'manual' })
record({ id: 'C02', desc: '口令错误 → 401 登录页，不下发 cookie', pass: r.status === 401 && !(r.headers.getSetCookie?.() ?? []).length, note: `${r.status}` })
r = await fetch(st.FN_URL, { redirect: 'manual' })
record({ id: 'C03', desc: '绕过 CloudFront 直连 Lambda Function URL（无源头密钥）→ 403', pass: r.status === 403, note: `${r.status}` })
r = await fetch(`${CF}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
record({ id: 'C04', desc: '未登录调用 /api/* → 401', pass: r.status === 401, note: `${r.status}` })
const wsNoCookie = await directWs(`wss://${st.DIST_DOMAIN}/api/remote.mux`, {})
record({ id: 'C05', desc: '未登录连接 /api/remote.mux → CloudFront Function 返回 401', pass: wsNoCookie.result === 'rejected' && wsNoCookie.status === 401, note: JSON.stringify(wsNoCookie) })

// ---------- alice 完整流程（阶段 A 用例经 CloudFront） ----------
const resA = await runUi('A', 'alice')
record({ id: 'C06', desc: '经 CloudFront 登录耗时（含 Cognito AdminInitiateAuth 与首页冷启动）', pass: true, note: `${resA.net.loginMs} ms` })

// ---------- bob：隔离 ----------
await runUi('I', 'bob')
const alice = token('alice')
const bob = token('bob')
const aliceSid = sidOf(alice)
const bobSid = sidOf(bob)
let d = await directInvoke(bob, aliceSid)
record({ id: 'C07', desc: 'bob 的有效令牌 + alice 的会话 ID 直接调用 AgentCore /invocations → 适配器 403', pass: d.innerStatus === 403, note: `AgentCore ${d.status}，内层 ${d.innerStatus}` })
d = await directInvoke(alice, aliceSid)
record({ id: 'C08', desc: '对照：alice 令牌 + alice 会话 ID 直接调用 → 200', pass: d.status === 200 && d.innerStatus === 200, note: `AgentCore ${d.status}，内层 ${d.innerStatus}` })
d = await directInvoke(null, aliceSid)
record({ id: 'C09', desc: '不带令牌直接调用 AgentCore → 被 JWT 授权器拒绝', pass: d.status === 401 || d.status === 403, note: `${d.status} ${d.body.slice(0, 100)}` })
const forged = alice.slice(0, -4) + (alice.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
d = await directInvoke(forged, aliceSid)
record({ id: 'C10', desc: '签名被篡改的令牌 → 被 JWT 授权器拒绝', pass: d.status === 401 || d.status === 403, note: `${d.status}` })
// 注意：AgentCore 在 /ws 上按 requestHeaderAllowlist 转发请求头时区分大小写，必须写成 Authorization；
// 小写 authorization 会被丢弃（适配器看不到令牌 → 403 → AgentCore 424）。/invocations 不受影响。
let w = await directWs(WS_URL(aliceSid), { Authorization: `Bearer ${bob}` })
record({ id: 'C11', desc: 'bob 令牌 + alice 会话 ID 直连 AgentCore /ws → 被拒绝或立即关闭', pass: w.result !== 'open', note: JSON.stringify(w) })
w = await directWs(WS_URL(aliceSid), { Authorization: `Bearer ${alice}` })
record({ id: 'C12', desc: '对照：alice 令牌 + alice 会话 ID 直连 /ws → 保持打开', pass: w.result === 'open', note: JSON.stringify(w) })
w = await directWs(WS_URL(aliceSid), { authorization: `Bearer ${alice}` })
record({ id: 'C15', desc: '记录行为：直连 /ws 时小写 authorization 不会被转发给容器 → 失败即关闭（424）', pass: w.result === 'rejected' && w.status === 424, note: JSON.stringify(w) })
w = await directWs(WS_URL(aliceSid), {})
record({ id: 'C13', desc: '不带令牌直连 /ws → 被拒绝', pass: w.result === 'rejected' || w.result === 'error', note: JSON.stringify(w) })
record({ id: 'C14', desc: '会话 ID 由令牌主体派生，两名用户互不相同', pass: aliceSid !== bobSid, note: `alice=${aliceSid} bob=${bobSid}` })

writeFileSync(join(RESULTS, 'cloud-cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 06 阶段 3（CloudFront + Cognito + AgentCore JWT）结果摘要', '', `- 运行时间：${new Date().toISOString()}；分发 ${st.DIST_DOMAIN}；Runtime ${st.RUNTIME_ARN}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((x) => !x.pass).length}`, '', '| 用例 | 用户 | 说明 | 结果 | 符合 |', '|---|---|---|---|---|']
for (const x of rows) md.push(`| ${x.id} | ${x.user ?? ''} | ${x.desc} | ${String(x.note ?? x.error ?? '').replace(/\|/g, '\\|').slice(0, 220)} | ${x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, 'cloud-summary.md'), md.join('\n') + '\n')
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)
process.exit(rows.some((x) => !x.pass) ? 1 : 0)

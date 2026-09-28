// Spike 09 编排（WSL 侧）。依赖 Spike 06 阶段 3 的部署（spikes/06-webui-tunnel/.state）。
// 阶段 L（并行，约 70 分钟）：
//   L-UI   alice：浏览器打开页面并保持 HOLD_MIN 分钟，之后不刷新直接发消息
//   L-WS   bob：原始 WebSocket 经 CloudFront 连接 /api/remote.mux，不发任何业务消息，记录何时、以何种方式关闭
//          （bob 的令牌有效期 60 分钟，覆盖「令牌在连接期间过期」）
//   STOP   carol：页面打开后 StopRuntimeSession，观察页面是否自动重连、能否不刷新继续对话、刷新后历史是否还在
// 阶段 M：Runtime maxLifetime 改为 300 s，dave 打开页面并观察 7 分钟（microVM 到期回收）
// 阶段 T：App Client 令牌有效期改为 5 分钟（maxLifetime 恢复），erin 打开页面并观察 8 分钟（令牌过期）
// 结果：results/*.json、results/summary.md
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const exec = promisify(execFile)
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const S06 = join(DIR, '..', '06-webui-tunnel')
const RESULTS = join(DIR, 'results'); mkdirSync(RESULTS, { recursive: true })
const WIN = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike07-ui'
const winPath = execFileSync('wslpath', ['-w', WIN], { encoding: 'utf8' }).trim()
cpSync(join(DIR, 'ui', 'long.mjs'), join(WIN, 'long.mjs'))
const HOLD_MIN = Number(process.env.HOLD_MIN ?? 70)
const PHASES = (process.env.PHASES ?? 'L,M,T').split(',')
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')]))
let st = readEnv(join(S06, '.state', 'state.env'))
const CF = `https://${st.DIST_DOMAIN}`
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const aws = async (...args) => JSON.parse((await exec('aws', [...args, '--output', 'json'], { maxBuffer: 1 << 24 })).stdout || 'null')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const record = (r) => { rows.push(r); log(`${r.pass === undefined ? '•' : r.pass ? '✓' : '✗'} ${r.id} ${r.desc} — ${r.note}`) }

const users = {}
async function ensureUser(name) {
  const pass = `Aa1!${randomBytes(10).toString('hex')}`
  await aws('cognito-idp', 'admin-create-user', '--user-pool-id', st.POOL_ID, '--username', name, '--message-action', 'SUPPRESS').catch(() => {})
  await aws('cognito-idp', 'admin-set-user-password', '--user-pool-id', st.POOL_ID, '--username', name, '--password', pass, '--permanent')
  users[name] = pass
  return pass
}
async function tokenOf(name) {
  const r = await aws('cognito-idp', 'admin-initiate-auth', '--user-pool-id', st.POOL_ID, '--client-id', st.CLIENT_ID, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${name},PASSWORD=${users[name]}`)
  const tok = r.AuthenticationResult.AccessToken
  const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString())
  return { tok, sub: p.sub, exp: p.exp * 1000, sid: `dsh-user-${p.sub}` }
}
function runUi(mode, out, user, minutes) {
  for (const f of readdirSync(WIN).filter((f) => f === `${out}.json` || f.startsWith(`${out}-`) || f === `${out}.go`)) rmSync(join(WIN, f), { force: true })
  const cred = join(WIN, `creds-${out}.json`)
  writeFileSync(cred, JSON.stringify({ username: user, password: users[user] }))
  const p = exec('cmd.exe', ['/c', `cd /d ${winPath} && node long.mjs ${CF}/ ${mode} ${out} creds-${out}.json ${minutes}`], { timeout: (minutes + 20) * 60000, maxBuffer: 1 << 26 })
    .catch((e) => e).finally(() => rmSync(cred, { force: true }))
  return p.then(() => {
    const res = existsSync(join(WIN, `${out}.json`)) ? JSON.parse(readFileSync(join(WIN, `${out}.json`), 'utf8')) : { timeline: [] }
    for (const f of readdirSync(WIN).filter((f) => f.startsWith(`${out}-`) && f.endsWith('.png'))) cpSync(join(WIN, f), join(RESULTS, f))
    writeFileSync(join(RESULTS, `${out}.json`), JSON.stringify(res, null, 1))
    return res
  })
}
async function waitTimeline(out, kind, maxMs = 600000) {
  const f = join(WIN, `${out}.json`)
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    // 页面在等待 go 之前只在就绪快照时写一次 json：以截图出现作为就绪信号
    if (existsSync(join(WIN, `${out}-ready.png`))) return true
    await sleep(2000)
  }
  return false
}
// Runtime 配置为 JWT 授权器时，StopRuntimeSession 也必须用 Bearer 令牌调用（SigV4 调用返回
// 「Authorization method mismatch」）；令牌只需被授权器接受，不要求属于该会话的用户
async function stopSession(sid, tok) {
  const r = await fetch(`https://bedrock-agentcore.${st.REGION}.amazonaws.com/runtimes/${encodeURIComponent(st.RUNTIME_ARN)}/stopruntimesession?qualifier=DEFAULT`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': sid }, body: '{}',
  })
  return `${r.status} ${(await r.text()).slice(0, 160)}`
}
// StopRuntimeSession 在页面就绪约 5 s 后发出（早于 go 标记），统计窗口从就绪开始
const stopAtS = (res) => res.timeline?.find((e) => e.kind === 'state' && e.tag === 'ready')?.t ?? 0
const reconnects = (res, from) => {
  const tl = res.timeline ?? []
  const go = from ?? tl.find((e) => e.kind === 'go')?.t ?? 0
  const end = tl.find((e) => e.kind === 'state' && e.tag === 'after-send-no-reload')?.t ?? Infinity
  const w = tl.filter((e) => e.t >= go && e.t <= end)
  return { closes: w.filter((e) => e.kind === 'ws-close').map((e) => `#${e.id}@${e.t}s`), opens: w.filter((e) => e.kind === 'ws-open').map((e) => `#${e.id}@${e.t}s`), go }
}
const summarizeUi = (res) => {
  const tl = res.timeline ?? []
  const closes = tl.filter((e) => e.kind === 'ws-close').map((e) => `#${e.id}@${e.t}s(${e.lifetimeS}s)`)
  const opens = tl.filter((e) => e.kind === 'ws-open').map((e) => `#${e.id}@${e.t}s`)
  const replies = tl.filter((e) => e.kind === 'reply').map((e) => `${e.tag}:${e.ok ? `ok ${e.ms}ms` : 'FAIL'}`)
  const hints = [...new Set(tl.filter((e) => e.kind === 'state').flatMap((e) => e.hints))].slice(0, 6)
  const httpErr = tl.filter((e) => e.kind === 'http-error').map((e) => `${e.status} ${e.url}@${e.t}s`).slice(0, 5)
  const nav = tl.filter((e) => e.kind === 'navigated').map((e) => `${e.url}@${e.t}s`)
  return { closes, opens, replies, hints, httpErr, nav }
}

// 原始 WebSocket：只连接、不发业务消息
function rawWs(tok, maxMs) {
  return new Promise((res) => {
    const t0 = Date.now()
    const r = { openedMs: null, closedMs: null, code: null, reason: null, msgs: 0, pings: 0, error: null }
    const ws = new WebSocket(`wss://${st.DIST_DOMAIN}/api/remote.mux`, { headers: { cookie: `dsh_token=${tok}` } })
    const timer = setTimeout(() => { r.stillOpenAtEnd = ws.readyState === WebSocket.OPEN; ws.terminate(); res(r) }, maxMs)
    ws.on('open', () => { r.openedMs = Date.now() - t0 })
    ws.on('message', () => { r.msgs++ })
    ws.on('ping', () => { r.pings++ })
    ws.on('unexpected-response', (_q, resp) => { r.error = `HTTP ${resp.statusCode}`; clearTimeout(timer); res(r) })
    ws.on('error', (e) => { r.error = e.message })
    ws.on('close', (code, reason) => { r.closedMs = Date.now() - t0; r.code = code; r.reason = String(reason); clearTimeout(timer); res(r) })
  })
}
async function adapterWsLogs(sinceMs) {
  const lg = `/aws/bedrock-agentcore/runtimes/${st.RUNTIME_ID}-DEFAULT`
  try {
    const { stdout } = await exec('aws', ['logs', 'filter-log-events', '--log-group-name', lg, '--start-time', String(sinceMs), '--filter-pattern', '?"ws bridged" ?"shutdown requested" ?"dsh web ready" ?"upstream ws error"', '--query', 'events[].[timestamp,message]', '--output', 'json'], { maxBuffer: 1 << 26 })
    return JSON.parse(stdout).map(([ts, m]) => `${new Date(ts).toISOString().slice(11, 19)} ${m.slice(0, 200)}`)
  } catch (e) { return [`logs error ${e.message.slice(0, 100)}`] }
}

if (process.env.RECONFIGURE_ONLY) { await reconfigure({ MAX_LIFETIME: process.env.MAX_LIFETIME ?? '28800', IDLE_TIMEOUT: process.env.IDLE_TIMEOUT ?? '900', TOKEN_VALIDITY_MINUTES: process.env.TOKEN_VALIDITY_MINUTES ?? '60' }); process.exit(0) }
for (const u of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) await ensureUser(u)

// ================= 阶段 L =================
if (PHASES.includes('L')) {
  const since = Date.now()
  const bob = await tokenOf('bob')
  log(`L 开始：HOLD_MIN=${HOLD_MIN}；bob 令牌 ${Math.round((bob.exp - Date.now()) / 60000)} 分钟后过期`)
  const pHold = runUi('hold', 'L-alice-hold', 'alice', HOLD_MIN)
  const pWs = rawWs(bob.tok, (HOLD_MIN + 2) * 60000)
  // STOP：carol
  rmSync(join(WIN, 'L-carol-stop.go'), { force: true })
  const carol = await tokenOf('carol')
  const pStop = runUi('watch', 'L-carol-stop', 'carol', 4)
  const ready = await waitTimeline('L-carol-stop')
  await sleep(5000)
  const stopRes = await stopSession(carol.sid, carol.tok)
  writeFileSync(join(WIN, 'L-carol-stop.go'), '')
  log(`carol：页面就绪=${ready}，StopRuntimeSession=${stopRes}`)
  // 对照：frank 同样的流程但不触发 StopRuntimeSession，区分「刷新本身」与「回收之后刷新」
  rmSync(join(WIN, 'L-frank-ctrl.go'), { force: true })
  const pCtrl = runUi('watch', 'L-frank-ctrl', 'frank', 4)
  await waitTimeline('L-frank-ctrl')
  writeFileSync(join(WIN, 'L-frank-ctrl.go'), '')
  const rs = await pStop
  const s = summarizeUi(rs)
  const rc = reconnects(rs, stopAtS(rs))
  record({ id: 'S01', desc: 'StopRuntimeSession 后打开着的页面：WebSocket 关闭并自动重连（刷新前）', pass: rc.closes.length >= 1 && rc.opens.length >= 1, note: `Stop=${stopRes}；go@${rc.go}s 之后关闭 ${rc.closes.join(' ') || '无'}，新开 ${rc.opens.join(' ') || '无'}；全程打开 ${s.opens.join(' ')}；提示 ${JSON.stringify(s.hints)}` })
  const noReload = rs.timeline.find((e) => e.kind === 'reply' && e.tag === '回收之后不刷新')
  const afterReload = rs.timeline.find((e) => e.kind === 'reply' && e.tag === '刷新之后')
  const hist = rs.timeline.find((e) => e.kind === 'history-after-reload')
  record({ id: 'S02', desc: '回收后不刷新页面继续对话', pass: Boolean(noReload?.ok), note: noReload ? `${noReload.ok ? 'ok' : 'FAIL'} ${noReload.ms} ms ${noReload.error ?? ''}` : '无记录' })
  const hf = rs.timeline.filter((e) => e.kind === 'history-load-failed').length
  record({ id: 'S03', desc: '回收后刷新页面：历史可见、可继续对话', pass: Boolean(afterReload?.ok && hist?.visible), note: `历史=${hist?.visible}；「历史加载失败」后再刷新 ${hf} 次；回复 ${afterReload?.ok ? `ok ${afterReload.ms} ms` : `FAIL ${afterReload?.error ?? ''}`}` })
  const rc2 = await pCtrl
  const c2 = summarizeUi(rc2)
  const hf2 = rc2.timeline.filter((e) => e.kind === 'history-load-failed').length
  const ar2 = rc2.timeline.find((e) => e.kind === 'reply' && e.tag === '刷新之后')
  record({ id: 'S04', desc: '对照（不回收，页面打开 4 分钟后刷新）：历史与对话', pass: Boolean(ar2?.ok), note: `「历史加载失败」后再刷新 ${hf2} 次；回复 ${ar2?.ok ? `ok ${ar2.ms} ms` : 'FAIL'}；WS 打开 ${c2.opens.join(' ')} 关闭 ${c2.closes.join(' ')}` })

  const [rh, rw] = await Promise.all([pHold, pWs])
  const h = summarizeUi(rh)
  const lastState = rh.timeline.filter((e) => e.kind === 'state').at(-2)
  record({ id: 'L01', desc: `浏览器页面保持 ${HOLD_MIN} 分钟：WebSocket 是否中断`, pass: h.closes.length === 0, note: `打开 ${h.opens.join(' ')}；关闭 ${h.closes.join(' ') || '无'}；结束前 wsOpen=${lastState?.wsOpen}；提示 ${JSON.stringify(h.hints)}` })
  const r2 = rh.timeline.find((e) => e.kind === 'reply' && e.tag === '保持之后不刷新')
  record({ id: 'L02', desc: `保持 ${HOLD_MIN} 分钟后不刷新直接对话`, pass: Boolean(r2?.ok), note: r2 ? `${r2.ok ? 'ok' : 'FAIL'} ${r2.ms} ms` : '无记录' })
  record({ id: 'L03', desc: `原始 WebSocket（只连接不发消息，令牌 60 分钟过期）保持 ${HOLD_MIN + 2} 分钟`, pass: rw.stillOpenAtEnd === true, note: JSON.stringify(rw) })
  writeFileSync(join(RESULTS, 'L-adapter-logs.json'), JSON.stringify(await adapterWsLogs(since), null, 1))
}

// ================= 阶段 M：maxLifetime 到期 =================
async function reconfigure(env) {
  // cloud/setup.sh 会重新上传约 60 MB 的代码包，偶发 S3 上传 EOF 失败（阶段 L 之后实测一次）→ 重试，并以 Runtime 实际配置为准
  for (let i = 1; i <= 3; i++) {
    log(`重新配置（第 ${i} 次）：${JSON.stringify(env)}`)
    const t0 = Date.now()
    const r = await exec('bash', [join(S06, 'cloud', 'setup.sh')], { env: { ...process.env, ...env }, timeout: 1800000, maxBuffer: 1 << 26 }).then((x) => x.stdout.slice(-300), (e) => `ERR ${e.stdout?.slice(-300)} ${e.stderr?.slice(-300)}`)
    st = readEnv(join(S06, '.state', 'state.env'))
    const rt = await aws('bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', st.RUNTIME_ID)
    const cl = await aws('cognito-idp', 'describe-user-pool-client', '--user-pool-id', st.POOL_ID, '--client-id', st.CLIENT_ID)
    const ok = rt.status === 'READY' && String(rt.lifecycleConfiguration?.maxLifetime) === env.MAX_LIFETIME && String(cl.UserPoolClient.AccessTokenValidity) === env.TOKEN_VALIDITY_MINUTES
    log(`重新配置${ok ? '完成' : '未生效'} ${Date.now() - t0} ms：version ${rt.agentRuntimeVersion} lifecycle ${JSON.stringify(rt.lifecycleConfiguration)} token ${cl.UserPoolClient.AccessTokenValidity} min；${r.replace(/\s+/g, ' ').slice(-120)}`)
    if (ok) return
  }
  throw new Error('reconfigure failed 3 times')
}
if (PHASES.includes('M')) {
  await reconfigure({ MAX_LIFETIME: '300', IDLE_TIMEOUT: '240', TOKEN_VALIDITY_MINUTES: '60' })
  const since = Date.now()
  rmSync(join(WIN, 'M-dave-lifetime.go'), { force: true })
  const p = runUi('watch', 'M-dave-lifetime', 'dave', 7)
  await waitTimeline('M-dave-lifetime')
  writeFileSync(join(WIN, 'M-dave-lifetime.go'), '')
  const res = await p
  const s = summarizeUi(res)
  const rc = reconnects(res)
  record({ id: 'M01', desc: 'maxLifetime=300 s 到期：打开着的页面 WebSocket 关闭并自动重连（刷新前）', pass: rc.closes.length >= 1 && rc.opens.length >= 1, note: `关闭 ${rc.closes.join(' ') || '无'}，新开 ${rc.opens.join(' ') || '无'}；全程打开 ${s.opens.join(' ')}；提示 ${JSON.stringify(s.hints)}` })
  const nr = res.timeline.find((e) => e.kind === 'reply' && e.tag === '回收之后不刷新')
  const ar = res.timeline.find((e) => e.kind === 'reply' && e.tag === '刷新之后')
  const hist = res.timeline.find((e) => e.kind === 'history-after-reload')
  record({ id: 'M02', desc: '到期回收后：不刷新继续对话 / 刷新后历史与对话', pass: Boolean(nr?.ok || (ar?.ok && hist?.visible)), note: `不刷新 ${nr?.ok ? `ok ${nr.ms} ms` : 'FAIL'}；刷新后历史=${hist?.visible} 回复 ${ar?.ok ? `ok ${ar.ms} ms` : 'FAIL'}` })
  writeFileSync(join(RESULTS, 'M-adapter-logs.json'), JSON.stringify(await adapterWsLogs(since), null, 1))
}

// ================= 阶段 T：令牌过期 =================
if (PHASES.includes('T')) {
  await reconfigure({ MAX_LIFETIME: '28800', IDLE_TIMEOUT: '900', TOKEN_VALIDITY_MINUTES: '5' })
  const erin = await tokenOf('erin')
  record({ id: 'T00', desc: '新签发令牌有效期', note: `${Math.round((erin.exp - Date.now()) / 1000)} s` })
  const pRaw = rawWs(erin.tok, 9 * 60000)
  const res = await runUi('expire', 'T-erin-expire', 'erin', 8)
  const rw = await pRaw
  const s = summarizeUi(res)
  const r2 = res.timeline.find((e) => e.kind === 'reply' && e.tag === '保持之后不刷新')
  const afterReload = res.timeline.filter((e) => e.kind === 'state' && e.tag === 'after-reload').at(-1)
  record({ id: 'T01', desc: '令牌过期后，已建立的 WebSocket 是否继续可用', note: `关闭 ${s.closes.join(' ') || '无'}；原始 WS ${JSON.stringify(rw)}` })
  record({ id: 'T02', desc: '令牌过期后不刷新直接对话', note: r2 ? `${r2.ok ? 'ok' : 'FAIL'} ${r2.ms} ms ${r2.error ?? ''}` : '无记录' })
  record({ id: 'T03', desc: '令牌过期后 HTTP 请求与刷新页面', pass: /\/auth\/login/.test(afterReload?.url ?? ''), note: `HTTP 错误 ${s.httpErr.join('；') || '无'}；导航 ${s.nav.join(' ')}；刷新后 URL ${afterReload?.url}` })
  record({ id: 'T04', desc: '令牌过期后界面提示', note: JSON.stringify(s.hints) })
  await reconfigure({ MAX_LIFETIME: '28800', IDLE_TIMEOUT: '900', TOKEN_VALIDITY_MINUTES: '60' })
}

const TAG = PHASES.join('') + (process.env.RUN_TAG ?? '')
writeFileSync(join(RESULTS, `cases-${TAG}.jsonl`), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 09 结果摘要（长连接、microVM 回收、令牌过期）', '', `- 运行时间：${new Date().toISOString()}；分发 ${st.DIST_DOMAIN}`, '', '| 用例 | 说明 | 结果 | 符合 |', '|---|---|---|---|']
for (const x of rows) md.push(`| ${x.id} | ${x.desc} | ${String(x.note).replace(/\|/g, '\\|').slice(0, 400)} | ${x.pass === undefined ? '记录' : x.pass ? '✓' : '✗'} |`)
writeFileSync(join(RESULTS, `summary-${TAG}.md`), md.join('\n') + '\n')
log('done')
process.exit(0)

// 官方 Web UI 长连接 / microVM 回收 / 令牌过期用例（Windows 侧 Edge + playwright-core 1.63.0）。
//   node long.mjs <url> <mode> <out> <loginFile> [minutes] [reply]
// reply：mock（默认，模拟模型上游，回复「这是模拟回复」）或 real（真实模型：请模型把 pong-<id> 转成大写回复，等待 PONG-<id> 出现）
// mode：
//   hold    登录 → 发一条消息 → 保持页面打开 minutes 分钟（每 30 s 记录 WebSocket 状态与页面提示，每 10 分钟截图）→ 再发一条消息
//   watch   登录 → 发一条消息 → 在 <out>.go 文件出现后（由 WSL 侧在触发 StopRuntimeSession / 等待到期后创建）观察 minutes 分钟
//           → 不刷新页面直接发消息 → 刷新页面再发消息
//   expire  登录 → 发一条消息 → 每 30 s 记录状态，持续 minutes 分钟（覆盖令牌过期）→ 不刷新发消息 → 刷新页面（期望跳转登录页）
// 时间线写到 <out>.json，截图 <out>-*.png。
import { chromium } from 'playwright-core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [url, mode, out, loginFile, minutesArg, replyArg] = process.argv.slice(2)
const minutes = Number(minutesArg ?? 5)
const real = replyArg === 'real'
const RUN = `x${Math.random().toString(36).slice(2, 8)}`
let seq = 0
const T0 = Date.now()
const t = () => Math.round((Date.now() - T0) / 1000)
const timeline = []
const ev = (kind, data = {}) => { const e = { t: t(), kind, ...data }; timeline.push(e); console.log(JSON.stringify(e)) }
const save = (extra = {}) => writeFileSync(`${out}.json`, JSON.stringify({ mode, minutes, timeline, ...extra }, null, 1))

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const wsList = []
page.on('websocket', (ws) => {
  const w = { id: wsList.length, url: ws.url().replace(/^wss:\/\/[^/]+/, ''), openedAt: t(), closedAt: null, rx: 0, tx: 0 }
  wsList.push(w); ev('ws-open', { id: w.id })
  ws.on('framereceived', () => { w.rx++ })
  ws.on('framesent', () => { w.tx++ })
  ws.on('socketerror', (e) => ev('ws-error', { id: w.id, error: String(e).slice(0, 120) }))
  ws.on('close', () => { w.closedAt = t(); ev('ws-close', { id: w.id, lifetimeS: w.closedAt - w.openedAt, rx: w.rx, tx: w.tx }) })
})
page.on('response', (r) => { if (r.status() >= 400) ev('http-error', { status: r.status(), url: r.url().replace(/^https:\/\/[^/]+/, '').slice(0, 100) }) })
page.on('framenavigated', (f) => { if (f === page.mainFrame()) ev('navigated', { url: f.url().replace(/^https:\/\/[^/]+/, '') }) })

const label = (l) => page.locator(`[aria-label="${l}"]`).first()
const body = () => page.evaluate(() => document.body.innerText).catch(() => '')
const HINT = /连接|断开|重连|离线|重新连接|offline|reconnect|disconnect|登录|失败|错误/i
async function snapshot(tag) {
  const b = await body()
  const hints = [...new Set(b.split('\n').map((s) => s.trim()).filter((s) => s && s.length < 80 && HINT.test(s)))].slice(0, 6)
  const open = wsList.filter((w) => w.closedAt === null).length
  ev('state', { tag, url: page.url().replace(/^https:\/\/[^/]+/, ''), wsOpen: open, wsTotal: wsList.length, hints, replies: (b.match(/这是模拟回复/g) ?? []).length })
}
async function send(msg) {
  await page.locator('[contenteditable="true"], textarea').first().click({ timeout: 10000 })
  await page.keyboard.type(msg, { delay: 3 })
  await label('发送消息').click({ timeout: 10000 })
}
let firstPrompt = '第一条[[TEXT]]'
async function sendAndWait(tag, timeoutMs = real ? 120000 : 60000) {
  const before = ((await body()).match(/这是模拟回复/g) ?? []).length
  const s = Date.now()
  try {
    if (real) {
      const id = `${RUN}${++seq}`
      const prompt = `${tag}：请把 pong-${id} 转成大写后原样回复，不要调用任何工具，不要输出其他内容。`
      if (seq === 1) firstPrompt = `pong-${id}`
      await send(prompt)
      // 模型会把整个 id 转成大写
      await page.waitForFunction((want) => document.body.innerText.includes(want), id.toUpperCase(), { timeout: timeoutMs })
    } else {
      await send(`${tag}[[TEXT]]`)
      await page.waitForFunction((n) => (document.body.innerText.match(/这是模拟回复/g) ?? []).length > n, before, { timeout: timeoutMs })
    }
    ev('reply', { tag, ok: true, ms: Date.now() - s })
    return true
  } catch (e) { ev('reply', { tag, ok: false, ms: Date.now() - s, error: e.message.split('\n')[0].slice(0, 160) }); return false }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 登录并准备会话（loginFile 为 - 时跳过登录：本机网关没有登录页）----
if (loginFile !== '-') {
  const creds = JSON.parse(readFileSync(loginFile, 'utf8'))
  await page.goto(new URL('/auth/login', url).href, { waitUntil: 'load', timeout: 60000 })
  await page.fill('#u', creds.username); await page.fill('#p', creds.password)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 120000 }), page.click('button[type="submit"]')])
} else await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {})
ev('logged-in')
await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})
if (!(await page.getByText('完全权限').first().isVisible().catch(() => false))) {
  await label('选择工作区').click({ timeout: 15000 })
  await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
  await page.locator('button:has-text("打开")').first().click({ timeout: 10000 })
  await page.getByText('完全权限').first().waitFor({ timeout: 15000 })
}
await sendAndWait('第一条')
await snapshot('ready')
await page.screenshot({ path: `${out}-ready.png` })

if (mode === 'hold' || mode === 'expire') {
  const end = Date.now() + minutes * 60000
  let n = 0
  while (Date.now() < end) {
    await sleep(30000)
    await snapshot(`t+${t()}s`)
    if (++n % 20 === 0) await page.screenshot({ path: `${out}-${t()}s.png` })
    save()
  }
  await page.screenshot({ path: `${out}-end.png` })
  await sendAndWait('保持之后不刷新')
  await snapshot('after-send')
  await page.screenshot({ path: `${out}-after-send.png` })
  if (mode === 'expire') {
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch((e) => ev('reload-error', { error: e.message.slice(0, 120) }))
    await sleep(3000)
    await snapshot('after-reload')
    await page.screenshot({ path: `${out}-after-reload.png` })
  }
}

if (mode === 'watch') {
  ev('waiting-for-go')
  while (!existsSync(`${out}.go`)) await sleep(1000)
  ev('go')
  const end = Date.now() + minutes * 60000
  while (Date.now() < end) { await sleep(10000); await snapshot(`t+${t()}s`); save() }
  await page.screenshot({ path: `${out}-before-send.png` })
  await sendAndWait('回收之后不刷新', 90000)
  await snapshot('after-send-no-reload')
  await page.screenshot({ path: `${out}-after-send.png` })
  await page.reload({ waitUntil: 'networkidle', timeout: 120000 }).catch((e) => ev('reload-error', { error: e.message.slice(0, 120) }))
  await page.locator('button:has-text("继续")').first().click({ timeout: 5000 }).catch(() => {})
  await snapshot('after-reload')
  // 刷新后若出现「历史加载失败」，记录并再刷新一次（用户的自然操作），观察是否恢复
  for (let k = 2; k <= 3 && /历史加载失败/.test(await body()); k++) {
    ev('history-load-failed', { attempt: k - 1 })
    await page.screenshot({ path: `${out}-reload-fail-${k - 1}.png` })
    await sleep(5000)
    await page.reload({ waitUntil: 'networkidle', timeout: 120000 }).catch((e) => ev('reload-error', { error: e.message.slice(0, 120) }))
    await snapshot(`after-reload-${k}`)
  }
  const hist = (await body()).includes(firstPrompt)
  ev('history-after-reload', { visible: hist })
  await sendAndWait('刷新之后', 90000)
  await page.screenshot({ path: `${out}-after-reload.png` })
}

save({ ws: wsList })
await browser.close()

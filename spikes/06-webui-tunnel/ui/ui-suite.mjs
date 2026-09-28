// 官方 Web UI 的浏览器用例（Windows 侧 Edge + playwright-core）。由 src/test/run_local.mjs 调用：
//   node ui-suite.mjs <url> <phase> <out-prefix>
// 结果写到 <out-prefix>.json，截图写到 <out-prefix>-<用例>.png。
//   phase A：首次使用（加载、选工作区、文本对话、工具调用、停止生成、文件预览）
//   phase B：适配器（DSH 进程）重启后，新浏览器上下文打开：会话仍在、历史可见、可在旧会话继续对话
//   phase C：加固补丁下：加载无错误、对话可用、设置入口状态
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const [url, phase, out, mode, loginFile] = process.argv.slice(2)
// hardened：运行时叠加了加固补丁，页面加载时对 settings/describe 的 404 是预期内的（见 dsh/web-hardening.cordis.yml）
const hardened = mode === 'hardened'
const unexpectedFailed = () => net.failed.filter((f) => !(hardened && f.includes('/api/settings/describe')))
const unexpectedConsole = () => net.console.filter((c) => !(hardened && c.includes('404')))
const cases = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const net = { console: [], failed: [], requests: 0, ws: [] }
page.on('console', (m) => { if (m.type() === 'error') net.console.push(m.text().slice(0, 300)) })
page.on('request', () => { net.requests++ })
page.on('requestfailed', (r) => net.failed.push(`${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) net.failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`) })
page.on('websocket', (ws) => { const w = { url: ws.url(), closed: false }; net.ws.push(w); ws.on('close', () => { w.closed = true }) })

const label = (l) => page.locator(`[aria-label="${l}"]`).first()

// 阶段 3：先经 /auth/login 登录（凭证从临时文件读取，运行后由编排脚本删除）
if (loginFile) {
  const { readFileSync } = await import('node:fs')
  const creds = JSON.parse(readFileSync(loginFile, 'utf8'))
  const t = Date.now()
  await page.goto(new URL('/auth/login', url).href, { waitUntil: 'load', timeout: 60000 })
  await page.fill('#u', creds.username)
  await page.fill('#p', creds.password)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 90000 }), page.click('button[type="submit"]')])
  // 跳转后的首页还会加载约 10 MB 插件包并建立一条 WebSocket；等它安定，免得计入 U01 的重新加载
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(1500)
  net.loginMs = Date.now() - t
  net.console.length = 0
  net.failed.length = 0
}
const text = (t) => page.getByText(t, { exact: false }).first()
const composer = () => page.locator('[contenteditable="true"], textarea').first()
async function send(msg) {
  await composer().click({ timeout: 10000 })
  await page.keyboard.type(msg, { delay: 3 })
  const t = Date.now()
  await label('发送消息').click({ timeout: 10000 })
  return t
}
async function run(id, desc, fn) {
  const t0 = Date.now()
  const c = { id, desc, pass: false }
  try {
    Object.assign(c, (await fn()) ?? {})
    if (c.pass === false && c.note === undefined) c.pass = true
  } catch (e) {
    c.pass = false
    c.error = e.message.split('\n')[0].slice(0, 300)
  }
  c.ms = Date.now() - t0
  await page.screenshot({ path: `${out}-${id}.png` }).catch(() => {})
  cases.push(c)
  console.log(`${c.pass ? '✓' : '✗'} ${id} ${desc} ${c.note ?? c.error ?? ''}`)
}

if (phase === 'A') {
  await run('U01', '页面经隧道加载：无控制台错误、无失败请求、建立 1 条 /api/remote.mux WebSocket', async () => {
    const t = Date.now()
    // 阶段 3 登录后跳转到 / 时页面已经加载过一次并建立过连接；只统计本次加载建立的 WebSocket
    net.ws.length = 0
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    const loadMs = Date.now() - t
    await page.waitForTimeout(1500)
    const ok = unexpectedConsole().length === 0 && unexpectedFailed().length === 0 && net.ws.filter((w) => w.url.endsWith('/api/remote.mux')).length === 1
    return { pass: ok, loadMs, requests: net.requests, console: [...net.console], failed: [...net.failed], note: `加载 ${loadMs} ms，${net.requests} 个请求` }
  })
  await run('U02', '关闭内测声明，经目录选择器选择 ~/workspace 作为工作区', async () => {
    // 内测声明只在首次出现；AgentCore 时延较高时它可能晚于页面主体出现，因此等待但不强制
    await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})
    // 阶段 3 使用持久化的会话存储：重复运行时工作区已在上一次选好（输入框下方已有「完全权限」），直接记为已持久化
    if (await text('完全权限').isVisible().catch(() => false)) return { pass: true, note: '工作区已从上次运行持久化，无需重新选择' }
    await label('选择工作区').click({ timeout: 10000 })
    await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
    await page.locator('button:has-text("打开")').first().click({ timeout: 10000 })
    // 选中工作区后，输入框下方才出现访问模式与模型选择
    await text('完全权限').waitFor({ timeout: 15000 })
    return { pass: true }
  })
  await run('U03', '文本对话：发送后助手回复逐段渲染完成', async () => {
    const t = await send('打个招呼[[TEXT]]')
    await text('这是模拟回复').waitFor({ timeout: 60000 })
    return { pass: true, sendToReplyMs: Date.now() - t, note: `发送→回复出现 ${Date.now() - t} ms` }
  })
  await run('U04', '工具调用：bash 在工作空间写文件，界面显示工具调用与后续回复', async () => {
    const t = await send('写一个文件[[TOOL]]')
    await text('工具已执行完毕').waitFor({ timeout: 60000 })
    await text('1 次工具调用').waitFor({ timeout: 5000 })
    return { pass: true, note: `发送→完成 ${Date.now() - t} ms` }
  })
  await run('U05', '停止生成：新会话慢速流式中点击「停止生成」，按钮消失、后续片段不再到达', async () => {
    await page.getByText('新会话', { exact: true }).first().click({ timeout: 10000 })
    await page.waitForTimeout(1000)
    await send('慢慢说[[SLOW]]')
    await text('片8').waitFor({ timeout: 30000 })
    const t = Date.now()
    await label('停止生成').click({ timeout: 5000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null), null, { timeout: 10000 })
    const stopMs = Date.now() - t
    const body1 = await page.evaluate(() => document.body.innerText)
    await page.waitForTimeout(5000)
    const body2 = await page.evaluate(() => document.body.innerText)
    const last = (s) => Math.max(...[...s.matchAll(/片(\d+)/g)].map((m) => Number(m[1])))
    const l1 = last(body1)
    const l2 = last(body2)
    return { pass: l1 < 99 && l1 === l2, stopMs, lastPieceAtStop: l1, lastPieceAfter5s: l2, note: `点击→停止控件消失 ${stopMs} ms，停止时最后一片 片${l1}，5 秒后 片${l2}` }
  })
  await run('U06', '文件预览：右侧边栏文件树列出工作空间文件，点击 hello.txt 显示内容', async () => {
    const session = page.getByText('打个招呼[[TEXT]]', { exact: true }).first()
    // 重复运行时侧栏里的工作区可能是折叠的，先展开
    if (!(await session.isVisible().catch(() => false))) await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
    await session.click({ timeout: 10000 })
    await page.waitForTimeout(800)
    await label('打开右侧边栏').click({ timeout: 10000 })
    await page.getByText('hello.txt', { exact: true }).first().click({ timeout: 15000 })
    await page.waitForTimeout(1500)
    const shown = await page.evaluate(() => document.body.innerText.includes('spike05'))
    return { pass: shown, note: shown ? '预览显示 spike05' : '未看到文件内容' }
  })
}

if (phase === 'I') {
  await run('U10', '另一用户登录后看到的是自己的空白环境：没有他人的会话与工作区', async () => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })
    await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(2000)
    const body = await page.evaluate(() => document.body.innerText)
    const leaked = ['打个招呼[[TEXT]]', '写一个文件', '慢慢说'].filter((x) => body.includes(x))
    return { pass: leaked.length === 0 && body.includes('暂无会话'), leaked, note: leaked.length ? `看到他人内容：${leaked.join('、')}` : '会话列表为「暂无会话」' }
  })
}

if (phase === 'B') {
  await run('U07', 'DSH 进程重启后（同一持久目录）：会话列表与历史仍在，可在旧会话继续对话', async () => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await page.locator('button:has-text("继续")').first().click({ timeout: 3000 }).catch(() => {})
    await page.getByText('打个招呼[[TEXT]]', { exact: true }).first().click({ timeout: 15000 })
    await text('工具已执行完毕').waitFor({ timeout: 15000 })
    const t = await send('还记得吗[[TEXT]]')
    await page.waitForFunction(() => (document.body.innerText.match(/这是模拟回复/g) ?? []).length >= 2, null, { timeout: 60000 })
    return { pass: unexpectedConsole().length === 0, console: [...net.console], note: `旧会话历史可见；继续对话回复 ${Date.now() - t} ms` }
  })
}

if (phase === 'C') {
  await run('U08', '加固补丁下：页面可用、可新建会话对话；失败请求只有被关闭的 settings/describe', async () => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await page.locator('button:has-text("继续")').first().click({ timeout: 3000 }).catch(() => {})
    await page.getByText('新会话', { exact: true }).first().click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
    const t = await send('加固后打招呼[[TEXT]]')
    await page.waitForFunction(() => document.body.innerText.includes('这是模拟回复'), null, { timeout: 60000 })
    const unexpected = net.failed.filter((f) => !f.includes('/api/settings/describe'))
    return { pass: unexpected.length === 0, console: [...net.console], failed: [...net.failed], note: `回复 ${Date.now() - t} ms；失败请求 ${net.failed.length} 个（均为 settings/describe=${unexpected.length === 0}）` }
  })
  await run('U09', '加固补丁下：设置面板里没有模型/插件/凭证配置页', async () => {
    const hasSettings = await label('设置').count()
    if (hasSettings) { await label('设置').click({ timeout: 10000 }); await page.waitForTimeout(1500) }
    const body = await page.evaluate(() => document.body.innerText)
    const has = (s) => body.includes(s)
    return { pass: !has('API Key') && !has('插件') && !has('凭证'), settingsEntry: hasSettings > 0, note: `设置入口=${hasSettings > 0}；页面含「插件」=${has('插件')}「API Key」=${has('API Key')}「凭证」=${has('凭证')}` }
  })
}

writeFileSync(`${out}.json`, JSON.stringify({ phase, cases, net }, null, 2))
await browser.close()

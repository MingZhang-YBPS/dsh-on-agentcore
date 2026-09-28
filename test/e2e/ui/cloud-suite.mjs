// 真实部署（CloudFront → 隧道 Lambda / AgentCore → 适配器 → DSH，真实模型）上的官方 Web UI 用例。
// Windows 侧 Edge + playwright-core 1.63.0，由 test/e2e/cloud.ts 调用：
//   node cloud-suite.mjs <url> <phase> <out> <loginFile> <runId> [extraFile]
// 用例可在已有数据的会话上重复运行：工作区已选好时跳过选择；文件内容与提示词都带本次 runId。
//   phase A：加载、选工作区、文本对话、工具调用写文件、多轮上下文、文件预览、停止生成、令牌过期续期、大历史刷新
//   phase I：另一用户看不到 A 的会话与文件（extraFile：{"forbidden":[...]}）
//   phase D：并发对话（两名用户同时运行本阶段）
//   phase T：首页加载计时与插件包缓存状态（任务 6.3）
//   phase W：写入：新会话中用工具写 hello.txt
//   phase P：microVM 回收之后重新打开：W 的会话历史与文件仍在（extraFile：{"title":"...","marker":"..."}）
// 所有提示词都以 e2e-<runId>-<用户名> 开头，会话标题因此带有该前缀。
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'

const [url, phase, out, loginFile, runId, extraFile, onlyArg] = process.argv.slice(2)
const extra = extraFile && extraFile !== '-' ? JSON.parse(readFileSync(extraFile, 'utf8')) : {}
// 可选：只运行列出的用例（逗号分隔），用于排障
const only = onlyArg ? new Set(onlyArg.split(',')) : null
const origin = new URL(url).origin
const cases = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const net = { console: [], failed: [], requests: 0, ws: [], plugins: [], maxWsFrame: 0 }
// 加固补丁关闭了设置面板的 describe 接口，页面加载时它的 404 是预期内的（见 services/adapter/dsh/web-hardening.cordis.yml）
const expectedFail = (s) => s.includes('/api/settings/describe')
const unexpectedFailed = () => net.failed.filter((f) => !expectedFail(f))
const unexpectedConsole = () => net.console.filter((c) => !c.includes('404'))
page.on('console', (m) => { if (m.type() === 'error') net.console.push(m.text().slice(0, 300)) })
page.on('request', () => { net.requests++ })
page.on('requestfailed', (r) => net.failed.push(`${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText}`))
page.on('response', (r) => {
  if (r.status() >= 400) net.failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`)
  if (new URL(r.url()).pathname.startsWith('/plugins/')) {
    const h = r.headers()
    net.plugins.push({ status: r.status(), cache: h['x-cache'] ?? '', bytes: Number(h['content-length'] ?? 0), setCookie: 'set-cookie' in h })
  }
})
page.on('websocket', (ws) => {
  const w = { url: ws.url(), closed: false }
  net.ws.push(w)
  ws.on('close', () => { w.closed = true })
  ws.on('framereceived', (f) => { const n = typeof f.payload === 'string' ? Buffer.byteLength(f.payload) : f.payload.length; if (n > net.maxWsFrame) net.maxWsFrame = n })
})

const label = (l) => page.locator(`[aria-label="${l}"]`).first()
const text = (t) => page.getByText(t, { exact: false }).first()
const body = () => page.evaluate(() => document.body.innerText)
const composer = () => page.locator('[contenteditable="true"], textarea').first()
const LEAK = /DSML|<｜|｜>|tool▁call|function_calls/
const stopVisible = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null))
const newText = (before, after) => after.slice(before.length > 0 && after.startsWith(before) ? before.length : 0)
let seq = 0
let me = ''
// 会话标题取第一条提示词的前 16 个字符左右：所有提示词都以 e2e-<runId>-<用户> 开头，便于隔离与持久化检查
const tagOf = () => `e2e-${runId}-${me}`

async function send(msg, { fill = false } = {}) {
  await composer().click({ timeout: 10000 })
  // 长文本用 insertText 一次性插入（逐键输入 100 KB 太慢；编辑器不接受 fill）
  if (fill) await page.keyboard.insertText(msg)
  else await page.keyboard.type(msg, { delay: 3 })
  const t = Date.now()
  await label('发送消息').click({ timeout: 10000 })
  return t
}
// 等本轮生成结束：「停止生成」出现过又消失（或 15 s 内都没出现）；之后再等 1.5 s 让最后的渲染完成
async function waitTurn(t0, timeoutMs = 180000) {
  let seen = false
  while (Date.now() - t0 < timeoutMs) {
    const v = await stopVisible()
    if (v) seen = true
    if (!v && (seen || Date.now() - t0 > 15000)) { await page.waitForTimeout(1500); return Date.now() - t0 }
    await page.waitForTimeout(150)
  }
  throw new Error(`turn did not finish in ${timeoutMs} ms`)
}
/** 真实模型的确定性回复：请模型把 pong-<id> 转成大写，等待 PONG-<id> 出现 */
async function pong(tag, timeoutMs = 120000) {
  // id 全小写且含字母：它的大写形式不会出现在提示词里，只可能来自模型回复（不要求 PONG 前缀本身拼对，模型偶尔会写错）
  const id = `${runId}${me}${phase.toLowerCase()}${++seq}`
  const t = await send(`${tagOf()} ${tag}：请把 pong-${id} 转成大写后原样回复，不要调用任何工具，不要输出其他内容。`)
  await page.waitForFunction((want) => document.body.innerText.includes(want), id.toUpperCase(), { timeout: timeoutMs })
  return { id, ms: Date.now() - t }
}
async function run(id, desc, fn) {
  if (only && !only.has(id)) return
  const t0 = Date.now()
  const c = { id, desc, pass: false }
  try { Object.assign(c, (await fn()) ?? {}) } catch (e) { c.pass = false; c.error = (e.message.trim().split('\n')[0] || String(e)).slice(0, 300) }
  c.ms = Date.now() - t0
  await page.screenshot({ path: `${out}-${id}.png` }).catch(() => {})
  cases.push(c)
  console.log(`${c.pass ? '✓' : '✗'} ${id} ${desc} ${c.note ?? c.error ?? ''}`)
}
async function pickWorkspace() {
  await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})
  if (await text('完全权限').isVisible().catch(() => false)) return '已从上次运行持久化'
  await label('选择工作区').click({ timeout: 15000 })
  await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
  await page.locator('button:has-text("打开")').first().click({ timeout: 10000 })
  await text('完全权限').waitFor({ timeout: 15000 })
  return '经目录选择器选择'
}
async function newSession() {
  await page.getByText('新会话', { exact: true }).first().click({ timeout: 10000 })
  await page.waitForTimeout(1000)
}
/** 输入框下方的模型按钮：aria-label 形如「选择模型，当前 DeepSeek-V4.1-Flash，推理等级 High」 */
const modelButton = () => page.locator('[aria-label^="选择模型"]').first()
const currentModel = async () => /当前\s*([^，,]+)/.exec((await modelButton().getAttribute('aria-label')) ?? '')?.[1]?.trim()
async function selectModel(name) {
  await modelButton().click({ timeout: 10000 })
  await page.getByRole('menuitem', { name: /模型/ }).first().click({ timeout: 5000 })
  await page.getByRole('menuitemradio', { name, exact: true }).first().click({ timeout: 5000 })
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForFunction((n) => (document.querySelector('[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? '').includes(`当前 ${n}`), name, { timeout: 10000 })
}
/** 点击右侧边栏文件树里的文件（对话正文里也可能出现同名的行内代码，按位置取右半屏的那个） */
async function clickSidebarFile(name, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (const el of await page.getByText(name, { exact: true }).all()) {
      const box = await el.boundingBox().catch(() => null)
      // 只点可见区域内右半屏的那个（屏外的副本点击会让页面横向滚动）
      if (box && box.x > 700 && box.x + box.width <= 1400 && box.y >= 0 && box.y < 900 && box.width > 0) { await el.click(); return }
    }
    await page.waitForTimeout(300)
  }
  throw new Error(`${name} not found in the right sidebar`)
}
/** 右半屏（文件预览）里是否显示了该文本 */
const sidebarShows = (text, timeoutMs = 15000) => page.waitForFunction((t) => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.textContent?.includes(t)) continue
    const r = n.parentElement?.getBoundingClientRect()
    if (r && r.left > 700 && r.width > 0) return true
  }
  return false
}, text, { timeout: timeoutMs })
const tokenCookie = async () => (await context.cookies(origin)).find((c) => c.name === 'dsh_token')

// 页面可用：输入框出现，或（首次使用、数据被清空后还没有工作区时）出现「选择工作区」；首次使用还会先弹出内测声明
async function waitAppReady(timeoutMs = 120000) {
  const ready = '[contenteditable="true"], textarea, [aria-label="选择工作区"]'
  await page.locator(`${ready}, button:has-text("继续")`).first().waitFor({ timeout: timeoutMs })
  const notice = page.locator('button:has-text("继续")').first()
  if (await notice.isVisible().catch(() => false)) await notice.click({ timeout: 5000 }).catch(() => {})
  await page.locator(ready).first().waitFor({ timeout: timeoutMs })
}

// ---- 登录（凭证从临时文件读取，运行后由编排脚本删除）----
{
  const creds = JSON.parse(readFileSync(loginFile, 'utf8'))
  me = creds.username
  const t = Date.now()
  await page.goto(new URL('/auth/login', url).href, { waitUntil: 'load', timeout: 60000 })
  await page.fill('#u', creds.username)
  await page.fill('#p', creds.password)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 120000 }), page.click('button[type="submit"]')])
  // 「可用」= 输入框出现（DSH 插件全部加载完成）；networkidle 在长连接页面上不可靠，只再给 10 s
  await waitAppReady().catch(() => {})
  net.loginMs = Date.now() - t
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1500)
  net.loginPlugins = net.plugins.splice(0)
  net.console.length = 0
  net.failed.length = 0
}

if (phase === 'A') {
  await run('U01', '页面加载：无意外的控制台错误与失败请求，建立 1 条 /api/remote.mux WebSocket；插件包经缓存行为返回且不带 Set-Cookie', async () => {
    net.ws.length = 0
    const t = Date.now()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })
    const loadMs = Date.now() - t
    await page.waitForTimeout(1500)
    const wsCount = net.ws.filter((w) => w.url.endsWith('/api/remote.mux')).length
    const hits = net.plugins.filter((p) => /Hit/i.test(p.cache)).length
    const anyCookie = [...net.loginPlugins, ...net.plugins].some((p) => p.setCookie)
    const ok = unexpectedConsole().length === 0 && unexpectedFailed().length === 0 && wsCount === 1 && !anyCookie
    return {
      pass: ok, loadMs, loginMs: net.loginMs, console: [...net.console], failed: [...net.failed],
      pluginsFirstLoad: net.loginPlugins, pluginsReload: [...net.plugins],
      note: `登录+首页 ${net.loginMs} ms；重新加载 ${loadMs} ms；WebSocket ${wsCount}；插件请求 首次 ${net.loginPlugins.map((p) => p.cache || p.status).join('/')}，重新加载 ${net.plugins.map((p) => p.cache || p.status).join('/')}（命中 ${hits}）；Set-Cookie=${anyCookie}`,
    }
  })
  await run('U02', '关闭内测声明，选择 ~/workspace 作为工作区（重复运行时已持久化）', async () => ({ pass: true, note: await pickWorkspace() }))
  await run('U14', '模型：新会话中可在模型下拉切到 Bedrock deepseek.v3.2 对话，再切回 DeepSeek-V4.1-Flash', async () => {
    await newSession()
    const initial = await currentModel()
    const a = await pong('默认模型')
    await newSession()
    await selectModel('deepseek.v3.2')
    const b = await pong('Bedrock')
    await newSession()
    await selectModel('DeepSeek-V4.1-Flash')
    const back = await currentModel()
    // 模型选择会保存为该用户之后新会话的默认值，所以 initial 可能是上一次运行留下的选择；首次使用时是 DeepSeek-V4.1-Flash（见 U16）
    return { pass: back === 'DeepSeek-V4.1-Flash', initial, note: `新会话当前「${initial}」回复 ${a.ms} ms；新会话切到 deepseek.v3.2 回复 ${b.ms} ms；切回「${back}」` }
  })
  await run('U15', '记录行为：同一会话中途从 DeepSeek 官方切到 Bedrock deepseek.v3.2', async () => {
    await newSession()
    await pong('切换前')
    await selectModel('deepseek.v3.2')
    let ok = true
    let ms = 0
    try { ms = (await pong('切换后', 60000)).ms } catch { ok = false }
    const tail = (await body()).split('切换后').at(-1)?.replace(/\s+/g, ' ').slice(0, 120)
    await newSession()
    await selectModel('DeepSeek-V4.1-Flash')
    return { pass: true, switchedOk: ok, note: ok ? `切换后回复正确（${ms} ms）` : `切换后回复不正确：「${tail}」` }
  })
  await run('R02', '文本对话：真实模型流式回复，页面无原始标记', async () => {
    const b0 = await body()
    const t = await send(`${tagOf()} 用一句中文打个招呼，不要调用任何工具。`)
    const ms = await waitTurn(t)
    const b1 = await body()
    const added = newText(b0, b1)
    return { pass: added.length > 20 && !LEAK.test(b1), note: `发送→结束 ${ms} ms；新增「${added.replace(/\s+/g, ' ').slice(-60)}」` }
  })
  await run('R03', '工具调用：模型调用 bash 在工作空间写 hello.txt 并报告输出；界面显示工具调用，展开后无原始标记', async () => {
    const t = await send(`${tagOf()} 请调用 bash 工具执行命令 \`echo dsh-e2e-${runId} > hello.txt && cat hello.txt\`，然后告诉我输出。`)
    const ms = await waitTurn(t)
    await page.waitForFunction((m) => /次工具调用/.test(document.body.innerText) && document.body.innerText.split(m).length > 2, `dsh-e2e-${runId}`, { timeout: 60000 }).catch(() => {})
    const b1 = await body()
    const toolShown = /次工具调用/.test(b1)
    await text('次工具调用').click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)
    const leak = LEAK.test(await body())
    // dsh-e2e-<runId> 在提示词里出现 1 次，工具输出（或模型转述）至少再出现 1 次
    return { pass: toolShown && b1.split(`dsh-e2e-${runId}`).length > 2 && !leak, note: `发送→结束 ${ms} ms；工具调用=${toolShown}；原始标记=${leak}` }
  })
  await run('R04', '多轮上下文：追问上一轮工具输出', async () => {
    const b0 = await body()
    const t = await send('刚才那条命令输出的内容是什么？只回答输出本身，不要调用工具。')
    const ms = await waitTurn(t)
    const added = newText(b0, await body())
    return { pass: added.includes(`dsh-e2e-${runId}`), note: `发送→结束 ${ms} ms；新增「${added.replace(/\s+/g, ' ').slice(-60)}」` }
  })
  await run('U06', '文件预览：右侧边栏文件树列出 hello.txt，点击后显示本次写入的内容', async () => {
    await label('打开右侧边栏').click({ timeout: 10000 }).catch(() => {})
    const marker = `dsh-e2e-${runId}`
    await clickSidebarFile('hello.txt')
    // 对话里也有该内容：只看右半屏的文件预览；没打开时再点一次
    await sidebarShows(marker, 7000).catch(async () => { await clickSidebarFile('hello.txt'); await sidebarShows(marker) })
    await label('关闭右侧边栏').click({ timeout: 3000 }).catch(() => {})
    return { pass: true, note: `预览显示 ${marker}` }
  })
  await run('R05', '停止生成：长回复流式输出中点击「停止生成」，按钮消失且之后页面不再追加内容', async () => {
    await newSession()
    const b0 = (await body()).length
    const t = await send(`${tagOf()} 写一篇不少于三千字的中文散文，主题是秋天的城市。直接输出正文，不要调用任何工具，不要创建文件。`)
    // 等正文开始流式输出（页面文本增长 300 字以上）；真实模型有时先长时间思考，60 s 内没有输出就在思考阶段停止
    let firstMs = null
    while (Date.now() - t < 60000) {
      if ((await body()).length - b0 > 300 && (await stopVisible())) { firstMs = Date.now() - t; break }
      await page.waitForTimeout(200)
    }
    const stage = firstMs === null ? '60 s 内未开始输出，在思考阶段停止' : `开始输出 ${firstMs} ms`
    if (!(await stopVisible())) throw new Error(`「停止生成」不可见（${stage}）`)
    const t1 = Date.now()
    await label('停止生成').click({ timeout: 5000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null), null, { timeout: 10000 })
    const stopMs = Date.now() - t1
    await page.waitForTimeout(1000)
    const l1 = (await body()).length
    await page.waitForTimeout(5000)
    const l2 = (await body()).length
    return { pass: l1 === l2, note: `${stage}；点击→停止 ${stopMs} ms；停止后 1 s 页面文本 ${l1} 字，再过 5 s ${l2} 字` }
  })
  await run('U12', '令牌过期续期：把 dsh_token 换成已过期的令牌后不刷新继续对话；隧道用刷新令牌续期，页面不中断', async () => {
    const cur = await tokenCookie()
    if (!cur) throw new Error('no dsh_token cookie')
    const [h, p] = cur.value.split('.')
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
    const expired = { ...payload, exp: Math.floor(Date.now() / 1000) - 60 }
    // 签名无效也无妨：隧道只从 payload 读 exp 与 username，续期后用 Cognito 新签发的令牌调用 AgentCore
    const forged = `${h}.${Buffer.from(JSON.stringify(expired)).toString('base64url')}.invalid-signature`
    await context.addCookies([{ ...cur, value: forged }])
    const r = await pong('续期')
    const after = await tokenCookie()
    const renewed = Boolean(after && after.value !== forged && after.value.split('.').length === 3 && JSON.parse(Buffer.from(after.value.split('.')[1], 'base64url').toString()).exp * 1000 > Date.now())
    return { pass: renewed && !page.url().includes('/auth/'), note: `回复 ${r.ms} ms；cookie 已换成新令牌=${renewed}；URL ${new URL(page.url()).pathname}` }
  })
  await run('U13', '大历史刷新：约 80 KB 的用户消息使历史快照超过 AgentCore 64 KB 单帧上限，刷新后仍完整加载', async () => {
    await newSession()
    const block = `这是用于验证 WebSocket 分片的填充文本 ${runId}。`.repeat(1)
    const filler = Array.from({ length: 1400 }, (_, i) => `${i} ${block}`).join('\n')
    const id = `${runId}${me}big`
    const want = id.toUpperCase()
    const t = await send(`${tagOf()} 请忽略下面的填充内容，只把 pong-${id} 转成大写后原样回复，不要调用工具。\n${filler}`, { fill: true })
    await page.waitForFunction((w) => document.body.innerText.includes(w), want, { timeout: 180000 })
    const replyMs = Date.now() - t
    net.maxWsFrame = 0
    await page.reload({ waitUntil: 'networkidle', timeout: 120000 })
    await page.waitForFunction((w) => document.body.innerText.includes(w), want, { timeout: 60000 }).catch(() => {})
    const b = await body()
    const visible = b.includes(want)
    return { pass: visible && !/历史加载失败/.test(b) && net.maxWsFrame > 65536, bytes: Buffer.byteLength(filler), maxWsFrame: net.maxWsFrame, note: `消息 ${Math.round(Buffer.byteLength(filler) / 1024)} KB，回复 ${replyMs} ms；刷新后历史可见=${visible}；刷新后收到的最大 WebSocket 消息 ${Math.round(net.maxWsFrame / 1024)} KB` }
  })
}

if (phase === 'I') {
  await run('U10', '另一用户：看不到 A 的会话、文件内容与提示词', async () => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })
    await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(2000)
    const b = await body()
    const leaked = (extra.forbidden ?? []).filter((x) => b.includes(x))
    return { pass: leaked.length === 0, leaked, note: leaked.length ? `看到他人内容：${leaked.join('、')}` : `检查 ${extra.forbidden?.length ?? 0} 个标记，均不可见` }
  })
}

if (phase === 'D') {
  await run('D01', '并发对话：与另一用户同时各发 3 条消息，全部得到回复', async () => {
    await pickWorkspace()
    await newSession()
    const model = await currentModel()
    const ms = []
    for (let i = 0; i < 3; i++) ms.push((await pong(`并发${i + 1}`)).ms)
    return { pass: true, model, note: `模型「${model}」；回复 ${ms.join(' / ')} ms` }
  })
}

if (phase === 'W') {
  await run('W01', '写入：新会话中调用 bash 在工作空间写 hello.txt（内容带本次 runId）', async () => {
    await pickWorkspace()
    await newSession()
    const t = await send(`${tagOf()} 请调用 bash 工具执行命令 \`echo dsh-e2e-${runId} > hello.txt && cat hello.txt\`，然后告诉我输出。`)
    const ms = await waitTurn(t)
    const ok = (await body()).includes(`dsh-e2e-${runId}`)
    return { pass: ok, note: `发送→结束 ${ms} ms；输出含 dsh-e2e-${runId}=${ok}` }
  })
}

if (phase === 'P') {
  await run('P01', 'microVM 回收后重新打开：冷启动内加载完成，写入时的会话在列表中且历史可见', async () => {
    await page.locator('button:has-text("继续")').first().click({ timeout: 5000 }).catch(() => {})
    const item = page.locator('[role="treeitem"]', { hasText: extra.title }).first()
    if (!(await item.isVisible().catch(() => false))) await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 }).catch(() => {})
    await item.click({ timeout: 20000 })
    await page.waitForFunction((m) => document.body.innerText.includes(m), extra.marker, { timeout: 30000 })
    return { pass: net.loginMs <= 60000, coldMs: net.loginMs, note: `登录→首页可用 ${net.loginMs} ms；会话「${extra.title}」历史可见（含 ${extra.marker}）` }
  })
  await run('P02', '回收后 hello.txt 仍在：右侧边栏预览显示写入的内容', async () => {
    await pickWorkspace()
    await label('打开右侧边栏').click({ timeout: 10000 }).catch(() => {})
    await clickSidebarFile('hello.txt', 20000)
    const shown = await sidebarShows(extra.marker, 7000).catch(async () => { await clickSidebarFile('hello.txt'); await sidebarShows(extra.marker, 15000) }).then(() => true, () => false)
    await label('关闭右侧边栏').click({ timeout: 3000 }).catch(() => {})
    return { pass: shown, note: shown ? `预览显示 ${extra.marker}` : '预览中没有看到内容' }
  })
  await run('P03', '回收后在新会话继续对话', async () => {
    await newSession()
    const r = await pong('回收之后')
    return { pass: true, note: `回复 ${r.ms} ms` }
  })
}

if (phase === 'T') {
  // 首页加载计时（新浏览器上下文、无浏览器缓存）：登录提交 → 输入框可用；记录每个插件包请求的 CloudFront 缓存状态
  await run('T01', '首页加载耗时与插件包缓存状态', async () => {
    const ps = net.loginPlugins
    const hits = ps.filter((x) => /Hit/i.test(x.cache)).length
    // Resource Timing：各请求耗时与传输字节，找出首页加载的主要耗时
    const res = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => ({ name: e.name.replace(location.origin, '').slice(0, 90), start: Math.round(e.startTime), ms: Math.round(e.duration), kb: Math.round((e.transferSize || e.encodedBodySize) / 1024) })))
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null })
    const kb = res.filter((x) => x.name.startsWith('/plugins/')).reduce((n, x) => n + x.kb, 0)
    const slow = [...res].sort((x, y) => y.ms - x.ms).slice(0, 5).map((x) => `${x.name.slice(0, 40)} @${x.start}+${x.ms}ms ${x.kb}KB`)
    return { pass: true, loginMs: net.loginMs, hits, total: ps.length, nav, resources: res, note: `登录→首页可用 ${net.loginMs} ms；插件请求 ${ps.length} 个（命中 ${hits}），传输 ${kb} KB；首页 TTFB ${nav?.ttfb} ms；最慢：${slow.join('；')}` }
  })
}

// 供编排脚本做隔离检查：本用户侧栏里的会话标题
const sidebar = await page.evaluate(() => [...document.querySelectorAll('[role="button"], a, li, button')].map((e) => e.textContent?.trim() ?? '').filter((s) => s.length >= 4 && s.length <= 60))
writeFileSync(`${out}.json`, JSON.stringify({ phase, cases, net, sidebar: [...new Set(sidebar)] }, null, 2))
await browser.close()

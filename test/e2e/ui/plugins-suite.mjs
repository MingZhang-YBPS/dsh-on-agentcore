// 插件设置页与网页搜索的浏览器用例（Windows 侧 Edge + playwright-core 1.63.0）。本机集成与真实部署共用：
//   node plugins-suite.mjs <url> <out> <loginFile|-> <search: mock|real|skip> [runId]
//   loginFile 为 - 时不登录（本机网关没有登录页）；search=mock 用模拟模型的 [[SEARCH]]，real 让真实模型调用 web_search。
// 用例（可重复运行：终端超时在两个值之间切换，最后恢复默认）：
//   G01 设置面板有「插件」，没有「模型」
//   G02 插件页：插件配置（终端、Agent 循环、Subagent、网页搜索）与插件列表两个视图
//   G03 网页搜索卡片：API Key 由部署管理（已配置时显示「已配置密钥」且不可编辑）
//   G04 修改终端命令超时并保存，刷新后仍在；恢复默认后回到默认值
//   G05 修改网页搜索的接口地址被部署拒绝，页面提示「本部署没有接受这些值」
//   G06 插件列表列出已加载的插件
//   G07 对话中调用 web_search，经适配器的 DeepSeek 代理返回结果
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'

const [url, out, loginFile, search = 'skip', runId = Math.random().toString(36).slice(2, 8)] = process.argv.slice(2)
const cases = []
// 本机集成用 *.test 主机名访问（解析到 127.0.0.1）：页面地址不是回环地址，与经 CloudFront 访问时一致
// （DSH 客户端对回环地址与非回环地址的设置读写行为不同，见 services/adapter/src/html-inject.ts）
const pageHost = new URL(url).hostname
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: pageHost.endsWith('.test') ? [`--host-resolver-rules=MAP ${pageHost} 127.0.0.1`] : [] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const net = { rpc: [], console: [] }
page.on('console', (m) => { if (m.type() === 'error') net.console.push(m.text().slice(0, 200)) })
context.on('response', async (r) => {
  if (/\/api\/(settings|credentials)\/(update|replace|mutate|set|unset)/.test(r.url())) net.rpc.push(`${new URL(r.url()).pathname} ${(r.request().postData() ?? '').slice(0, 200)} <- ${(await r.text().catch(() => '')).slice(0, 160)}`)
})
const label = (l) => page.locator(`[aria-label="${l}"]`).first()
const text = (t) => page.getByText(t, { exact: true }).first()
const body = () => page.evaluate(() => document.body.innerText)
const saveButton = () => page.getByRole('button', { name: '保存', exact: true })
async function run(id, desc, fn) {
  const t0 = Date.now()
  const c = { id, desc, pass: false }
  try { Object.assign(c, (await fn()) ?? {}) } catch (e) { c.pass = false; c.error = (e.message.trim().split('\n')[0] || String(e)).slice(0, 300) }
  c.ms = Date.now() - t0
  await page.screenshot({ path: `${out}-${id}.png` }).catch(() => {})
  cases.push(c)
  console.log(`${c.pass ? '✓' : '✗'} ${id} ${desc} ${c.note ?? c.error ?? ''}`)
}
async function openPlugins() {
  await label('设置').click({ timeout: 15000 })
  await page.waitForTimeout(800)
  await text('插件').click({ timeout: 10000 })
  await text('插件配置').waitFor({ timeout: 10000 })
}
async function closeSettings() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}
// 卡片的展开状态会在页面内保留：按卡片里的输入框是否可见决定是否点击，而不是盲目切换
const CARD_INPUT = { 终端: '#plugin-config-bash-timeout', 网页搜索: '#plugin-config-web-search-endpoint' }
async function expand(card, open = true) {
  const sel = CARD_INPUT[card]
  const visible = sel ? await page.locator(sel).isVisible().catch(() => false) : !open
  if (visible !== open) { await text(card).click({ timeout: 10000 }); await page.waitForTimeout(600) }
  if (sel && open) await page.locator(sel).waitFor({ timeout: 10000 })
}
const collapse = (card) => expand(card, false)

// 页面可用：输入框出现，或（首次使用、数据被清空后还没有工作区时）出现「选择工作区」；首次使用还会先弹出内测声明
async function waitAppReady(timeoutMs = 120000) {
  const ready = '[contenteditable="true"], textarea, [aria-label="选择工作区"]'
  await page.locator(`${ready}, button:has-text("继续")`).first().waitFor({ timeout: timeoutMs })
  const notice = page.locator('button:has-text("继续")').first()
  if (await notice.isVisible().catch(() => false)) await notice.click({ timeout: 5000 }).catch(() => {})
  await page.locator(ready).first().waitFor({ timeout: timeoutMs })
}

if (loginFile !== '-') {
  const creds = JSON.parse(readFileSync(loginFile, 'utf8'))
  await page.goto(new URL('/auth/login', url).href, { waitUntil: 'load', timeout: 60000 })
  await page.fill('#u', creds.username)
  await page.fill('#p', creds.password)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 120000 }), page.click('button[type="submit"]')])
} else await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await waitAppReady()

await run('G01', '设置面板有「插件」，没有「模型」', async () => {
  await label('设置').click({ timeout: 15000 })
  await page.waitForTimeout(1200)
  const b = await body()
  const nav = b.slice(b.indexOf('设置'), b.indexOf('关闭') > 0 ? b.indexOf('关闭') : undefined)
  const ok = /插件/.test(nav) && !/模型/.test(b.split('探索未至之境')[0] ?? b)
  await closeSettings()
  return { pass: ok, note: `导航：${nav.replace(/\s+/g, ' ').slice(0, 80)}` }
})

await run('G02', '插件页：插件配置（终端、Agent 循环、Subagent、网页搜索）与插件列表两个视图', async () => {
  await openPlugins()
  const b = await body()
  const want = ['插件配置', '插件列表', '终端', 'Agent 循环', 'Subagent', '网页搜索']
  const missing = want.filter((w) => !b.includes(w))
  return { pass: missing.length === 0, note: missing.length ? `缺少 ${missing.join('、')}` : '四张卡片与两个视图都在' }
})

await run('G03', '网页搜索卡片：API Key 由部署管理，不能在页面上填写', async () => {
  await expand('网页搜索')
  const b = await body()
  const configured = b.includes('已配置密钥')
  const disabled = await page.locator('#plugin-config-web-search-key').isDisabled().catch(() => null)
  const endpoint = await page.locator('#plugin-config-web-search-endpoint').inputValue().catch(() => '')
  await collapse('网页搜索')
  // 已配置：密钥输入框禁用；未配置：显示「未配置密钥」，填写会被部署拒绝（见 G05 的同类拒绝）
  return { pass: configured ? disabled === true : b.includes('未配置密钥'), configured, note: `密钥${configured ? '已配置' : '未配置'}；输入框禁用=${disabled}；接口地址 ${endpoint.replace(/:\d+\//, ':<port>/')}` }
})

await run('G04', '修改终端命令超时并保存，刷新后仍在；恢复默认后回到默认值', async () => {
  await expand('终端')
  const input = page.locator('#plugin-config-bash-timeout')
  const before = await input.inputValue()
  const next = before === '45000' ? '50000' : '45000'
  await input.fill(next)
  await saveButton().click({ timeout: 5000 })
  await page.waitForFunction(() => !document.body.innerText.includes('保存中'), null, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'load', timeout: 90000 })
  await waitAppReady(90000)
  await openPlugins()
  await expand('终端')
  const persisted = await page.locator('#plugin-config-bash-timeout').inputValue()
  // 恢复默认：该字段的「恢复默认」按钮 + 保存
  await page.getByRole('button', { name: '恢复默认' }).first().click({ timeout: 5000 })
  // 恢复默认后卡片会重新渲染：保存（若仍有未保存的修改）后收起再展开读取
  if (await saveButton().isEnabled().catch(() => false)) await saveButton().click({ timeout: 5000 })
  await page.waitForTimeout(1500)
  await collapse('终端')
  await expand('终端')
  const reset = await page.locator('#plugin-config-bash-timeout').inputValue()
  await collapse('终端')
  return { pass: persisted === next && reset !== next, note: `原值 ${before} → 保存 ${next}，刷新后 ${persisted}；恢复默认后 ${reset}` }
})

await run('G05', '修改网页搜索的接口地址：部署拒绝，页面提示「本部署没有接受这些值」', async () => {
  await expand('网页搜索')
  await page.locator('#plugin-config-web-search-endpoint').fill('https://attacker.example/anthropic/v1')
  await saveButton().click({ timeout: 5000 })
  await page.waitForTimeout(2000)
  const b = await body()
  const rejected = b.includes('本部署没有接受这些值')
  await page.getByRole('button', { name: '放弃修改' }).first().click({ timeout: 5000 }).catch(() => {})
  await collapse('网页搜索')
  return { pass: rejected, note: rejected ? '保存被拒绝，草稿保留' : '没有看到拒绝提示' }
})

await run('G06', '插件列表列出已加载的插件', async () => {
  await text('插件列表').click({ timeout: 10000 })
  await page.waitForTimeout(1500)
  const b = await body()
  const n = (b.match(/已启用/g) ?? []).length
  await text('插件配置').click({ timeout: 10000 }).catch(() => {})
  await closeSettings()
  return { pass: n > 5 && b.includes('tool-bash'), note: `「已启用」${n} 项，含 tool-bash=${b.includes('tool-bash')}` }
})

if (search !== 'skip') {
  await run('G07', '对话中调用 web_search：经适配器的 DeepSeek 代理返回结果', async () => {
    await closeSettings()
    if (!(await page.getByText('完全权限').first().isVisible().catch(() => false))) {
      await label('选择工作区').click({ timeout: 15000 })
      await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
      await page.locator('button:has-text("打开")').first().click({ timeout: 10000 })
      await page.getByText('完全权限').first().waitFor({ timeout: 15000 })
    }
    await page.getByText('新会话', { exact: true }).first().click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
    await page.locator('[contenteditable="true"], textarea').first().click()
    const t = Date.now()
    if (search === 'mock') {
      await page.keyboard.type(`搜一下 ${runId}[[SEARCH]]`, { delay: 3 })
      await label('发送消息').click()
      await page.waitForFunction(() => document.body.innerText.includes('搜索已完成'), null, { timeout: 60000 })
      const b = await body()
      return { pass: b.includes('找到模拟来源'), note: `${Date.now() - t} ms；${b.includes('找到模拟来源') ? '工具结果含模拟来源' : '工具结果没有来源'}` }
    }
    await page.keyboard.type(`e2e-${runId} 请调用 web_search 工具搜索「Amazon Bedrock AgentCore Runtime」，然后用一句话回答它是什么，并附上一个来源链接。`, { delay: 3 })
    await label('发送消息').click()
    // 等工具调用标记出现、生成结束
    await page.waitForFunction(() => /次工具调用/.test(document.body.innerText), null, { timeout: 120000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null), null, { timeout: 180000 })
    await page.waitForTimeout(1500)
    await text('次工具调用').click({ timeout: 5000 }).catch(() => {})
    await page.getByText(/次工具调用/).first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const b = await body()
    const after = b.split(`e2e-${runId}`).at(-1) ?? ''
    const failed = /WEB_PROVIDER|CREDENTIAL_MISSING|not configured|未配置/.test(after)
    // 来源以带标题的链接渲染（页面文本里没有 URL）：检查页面上指向外站的链接
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href^="http"]')].map((a) => a.href).filter((h) => new URL(h).origin !== location.origin))
    const searched = /网页搜索/.test(after)
    return { pass: !failed && searched && links.length > 0, links: links.slice(0, 5), note: `${Date.now() - t} ms；工具「网页搜索」=${searched}；${failed ? '搜索失败' : '无错误'}；外站链接 ${links.length} 个（${links[0] ?? '无'}）` }
  })
}

writeFileSync(`${out}.json`, JSON.stringify({ phase: 'G', cases, net }, null, 2))
await browser.close()

// 真实模型下的官方 Web UI 用例（Windows 侧 Edge + playwright-core 1.63.0）。由 src/run-local.mjs / src/run-agentcore.mjs 调用：
//   node real-suite.mjs <url> <phase> <out-prefix>
//   phase R：选工作区 → 文本对话 → 工具调用 → 多轮上下文 → 停止生成；全程检查页面里没有模型原始标记（DSML）
//   phase E：模型标识无效时，对话界面显示错误且页面仍可用
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const [url, phase, out] = process.argv.slice(2)
const cases = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const net = { console: [], failed: [] }
page.on('console', (m) => { if (m.type() === 'error') net.console.push(m.text().slice(0, 300)) })
page.on('response', (r) => { if (r.status() >= 400) net.failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`) })

const label = (l) => page.locator(`[aria-label="${l}"]`).first()
const text = (t) => page.getByText(t, { exact: false }).first()
const body = () => page.evaluate(() => document.body.innerText)
const LEAK = /DSML|<｜|｜>|tool▁call|function_calls/
const stopVisible = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null))

async function send(msg) {
  await page.locator('[contenteditable="true"], textarea').first().click({ timeout: 10000 })
  await page.keyboard.type(msg, { delay: 3 })
  const t = Date.now()
  await label('发送消息').click({ timeout: 10000 })
  return t
}
// 等本轮生成结束：「停止生成」出现过又消失，或 3 s 后仍未出现（极快的回复）；上限 timeoutMs
async function waitTurn(t0, timeoutMs = 180000) {
  let seen = false
  let firstSeenMs = null
  while (Date.now() - t0 < timeoutMs) {
    const v = await stopVisible()
    if (v && !seen) { seen = true; firstSeenMs = Date.now() - t0 }
    if (!v && (seen || Date.now() - t0 > 3000)) return { doneMs: Date.now() - t0, stopSeenMs: firstSeenMs }
    await page.waitForTimeout(150)
  }
  throw new Error(`turn did not finish in ${timeoutMs} ms`)
}
async function run(id, desc, fn) {
  const t0 = Date.now()
  const c = { id, desc, pass: false }
  try { Object.assign(c, (await fn()) ?? {}) } catch (e) { c.pass = false; c.error = e.message.split('\n')[0].slice(0, 300) }
  c.ms = Date.now() - t0
  await page.screenshot({ path: `${out}-${id}.png` }).catch(() => {})
  cases.push(c)
  console.log(`${c.pass ? '✓' : '✗'} ${id} ${desc} ${c.note ?? c.error ?? ''}`)
}
const newText = (before, after) => after.slice(before.length > 0 && after.startsWith(before) ? before.length : 0)

await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })
await page.locator('button:has-text("继续")').first().click({ timeout: 8000 }).catch(() => {})

async function pickWorkspace() {
  if (await text('完全权限').isVisible().catch(() => false)) return
  await label('选择工作区').click({ timeout: 10000 })
  await page.getByText('workspace', { exact: true }).first().click({ timeout: 10000 })
  await page.locator('button:has-text("打开")').first().click({ timeout: 10000 })
  await text('完全权限').waitFor({ timeout: 15000 })
}

if (phase === 'R') {
  await run('R01', '选择 ~/workspace 作为工作区', async () => { await pickWorkspace(); return { pass: true } })

  await run('R02', '文本对话：真实模型流式回复，页面无原始标记', async () => {
    const b0 = await body()
    const t = await send('用一句中文打个招呼，不要调用任何工具。')
    const w = await waitTurn(t)
    const b1 = await body()
    const added = newText(b0, b1)
    return { pass: added.length > 20 && !LEAK.test(b1), ...w, leak: LEAK.test(b1), note: `发送→结束 ${w.doneMs} ms（停止控件 ${w.stopSeenMs ?? '未出现'} ms）；新增「${added.replace(/\s+/g, ' ').slice(-80)}」` }
  })

  await run('R03', '工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记', async () => {
    const t = await send('请调用 bash 工具执行命令 `echo spike07 > hello.txt && cat hello.txt`，然后告诉我输出。')
    const w = await waitTurn(t)
    const b1 = await body()
    const toolShown = /次工具调用/.test(b1)
    // 工具调用前的助手文本折叠在「N 次工具调用 · M 条消息」里，展开后再检查原始标记
    await text('次工具调用').click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)
    const b2 = await body()
    const leak = LEAK.test(b2)
    const leakSnippet = leak ? b2.slice(Math.max(0, b2.search(LEAK) - 60), b2.search(LEAK) + 60) : ''
    return { pass: toolShown && b1.includes('spike07') && !leak, ...w, toolShown, leak, note: `发送→结束 ${w.doneMs} ms；工具调用标记=${toolShown}；展开后原始标记=${leak}${leak ? `「${leakSnippet.replace(/\s+/g, ' ')}」` : ''}` }
  })

  await run('R04', '多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息）', async () => {
    const b0 = await body()
    const t = await send('刚才那条命令输出的内容是什么？只回答输出本身，不要调用工具。')
    const w = await waitTurn(t)
    const b1 = await body()
    const added = newText(b0, b1)
    return { pass: added.includes('spike07') && !LEAK.test(b1), ...w, note: `发送→结束 ${w.doneMs} ms；新增「${added.replace(/\s+/g, ' ').slice(-60)}」` }
  })

  await run('R05', '停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容', async () => {
    await page.getByText('新会话', { exact: true }).first().click({ timeout: 10000 })
    await page.waitForTimeout(1000)
    // Markdown 会把单个换行渲染成空格，所以按「1 2 3 … n」的连续整数序列计数；提示词里不出现阿拉伯数字
    const countRun = (s) => {
      const tk = s.split(/\s+/)
      let best = 0
      for (let i = 0; i < tk.length; i++) {
        if (tk[i] !== '1') continue
        let n = 1
        while (tk[i + n] === String(n + 1)) n++
        best = Math.max(best, n)
      }
      return best
    }
    const t = await send('从一开始数到两千，每个数字单独一行，不要调用工具，不要省略，不要加任何说明。')
    let firstMs = null
    while (Date.now() - t < 90000) {
      if (countRun(await body()) >= 50) { firstMs = Date.now() - t; break }
      await page.waitForTimeout(100)
    }
    if (firstMs === null) throw new Error('90 s 内没有数到 50')
    const t1 = Date.now()
    await label('停止生成').click({ timeout: 5000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="停止生成"]')].some((e) => e.offsetParent !== null), null, { timeout: 10000 })
    const stopMs = Date.now() - t1
    const l1 = countRun(await body())
    await page.waitForTimeout(5000)
    const l2 = countRun(await body())
    return { pass: l1 < 2000 && l1 === l2, stopMs, lastAtStop: l1, lastAfter5s: l2, note: `发送→数到 50：${firstMs} ms；点击→停止控件消失 ${stopMs} ms；停止时 ${l1}，5 秒后 ${l2}` }
  })
}

if (phase === 'E') {
  await run('E01', '模型不可用：对话界面显示错误，页面仍可用', async () => {
    await pickWorkspace()
    const b0 = await body()
    const t = await send('你好')
    const w = await waitTurn(t, 60000)
    await page.waitForTimeout(1000)
    const b1 = await body()
    const added = newText(b0, b1)
    const shown = /错误|失败|error|invalid|400|无效/i.test(added)
    const usable = await page.locator('[contenteditable="true"], textarea').first().isVisible()
    return { pass: shown && usable, ...w, note: `显示错误=${shown}；输入框可用=${usable}；新增「${added.replace(/\s+/g, ' ').slice(-160)}」` }
  })
}

writeFileSync(`${out}.json`, JSON.stringify({ phase, cases, net }, null, 2))
await browser.close()

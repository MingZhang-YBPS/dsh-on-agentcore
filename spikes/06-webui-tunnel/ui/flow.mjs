// 在 Windows 侧用 Edge 驱动官方 Web UI 走一遍对话流程，每步截图，并导出网络与控制台记录。
// 用法：node flow.mjs <url> <out-prefix> <step...>
//   步骤：continue | click:<aria-label 或按钮文字> | clicktext:<精确文本> | type:<文本> | send | wait:<出现的文本>[@超时ms] | sleep:<ms> | shot:<名字> | dump:<名字> | buttons:<名字>
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const [url, out, ...steps] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
const log = { url, steps: [], console: [], failed: [], requests: 0, ws: [] }
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log.console.push(`${m.type()}: ${m.text()}`.slice(0, 400)) })
page.on('request', () => { log.requests++ })
page.on('requestfailed', (r) => log.failed.push(`${r.method()} ${r.url().slice(0, 200)} ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) log.failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`) })
page.on('websocket', (ws) => {
  const w = { url: ws.url(), openedAt: Date.now(), sent: 0, received: 0, closedAt: null }
  log.ws.push(w)
  ws.on('framesent', () => w.sent++)
  ws.on('framereceived', () => w.received++)
  ws.on('close', () => { w.closedAt = Date.now() })
})

const t0 = Date.now()
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
log.steps.push({ step: 'load', ms: Date.now() - t0 })

const byLabel = (label) => page.locator(`[aria-label="${label}"], button:has-text("${label}")`).first()
for (const s of steps) {
  const [cmd, ...restParts] = s.split(':')
  const arg = restParts.join(':')
  const st = Date.now()
  let ok = true
  let note = ''
  try {
    if (cmd === 'continue') await page.locator('button:has-text("继续")').first().click({ timeout: 5000 }).catch(() => { note = 'no dialog' })
    else if (cmd === 'click') await byLabel(arg).click({ timeout: 10000 })
    else if (cmd === 'clicktext') await page.getByText(arg, { exact: true }).last().click({ timeout: 10000 })
    else if (cmd === 'type') {
      const box = page.locator('[contenteditable="true"], textarea').first()
      await box.click({ timeout: 10000 })
      await page.keyboard.type(arg, { delay: 5 })
    } else if (cmd === 'send') await byLabel('发送消息').click({ timeout: 10000 })
    else if (cmd === 'wait') {
      const [text, ms] = arg.split('@')
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: Number(ms ?? 30000) })
    } else if (cmd === 'sleep') await page.waitForTimeout(Number(arg))
    else if (cmd === 'shot') await page.screenshot({ path: `${out}-${arg}.png` })
    else if (cmd === 'buttons') {
      const b = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')].map((e) => ({ aria: e.getAttribute('aria-label'), title: e.getAttribute('title'), text: (e.innerText || '').trim().slice(0, 30) })).filter((x) => x.aria || x.title || x.text))
      writeFileSync(`${out}-${arg}.buttons.json`, JSON.stringify(b, null, 2))
    } else if (cmd === 'dump') {
      const html = await page.evaluate(() => document.body.innerText)
      writeFileSync(`${out}-${arg}.txt`, html)
    } else throw new Error(`unknown step ${s}`)
  } catch (e) { ok = false; note = e.message.split('\n')[0].slice(0, 200) }
  log.steps.push({ step: s, ok, ms: Date.now() - st, note })
  if (!ok) { await page.screenshot({ path: `${out}-fail.png` }); break }
}
writeFileSync(`${out}.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify(log.steps))
await browser.close()

// 在 Windows 侧用已安装的 Edge（playwright-core, channel msedge）打开网关地址，截图并导出可交互元素，
// 用于摸清官方 Web UI 的 DOM 结构。用法（Windows 侧）：node explore.mjs http://localhost:8000/ out-prefix
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:8000/'
const out = process.argv[3] ?? 'explore'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const consoleMsgs = []
const failed = []
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`) })
const t0 = Date.now()
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)
const loadMs = Date.now() - t0
await page.screenshot({ path: `${out}.png` })
const elems = await page.evaluate(() => {
  const pick = [...document.querySelectorAll('button, textarea, input, [contenteditable="true"], [role="button"], a')]
  return pick.slice(0, 120).map((e) => ({
    tag: e.tagName.toLowerCase(), text: (e.innerText || e.value || '').trim().slice(0, 40),
    aria: e.getAttribute('aria-label'), title: e.getAttribute('title'), testid: e.getAttribute('data-testid'),
    placeholder: e.getAttribute('placeholder'), cls: (e.className?.toString?.() || '').slice(0, 60),
  }))
})
writeFileSync(`${out}.json`, JSON.stringify({ url, loadMs, title: await page.title(), consoleMsgs, failed, elems }, null, 2))
console.log(JSON.stringify({ loadMs, title: await page.title(), console: consoleMsgs.length, failed: failed.length, elems: elems.length }))
await browser.close()

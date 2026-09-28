// 原始工具调用标记过滤器的离线检查：用探针录下的真实 SSE 事件（results/probe-events/P03-*.json 等），
// 以随机字节切块（含把标记本身切开）喂给过滤器 500 次，断言：
//   1. 输出是合法 SSE，且帧数与输入相同
//   2. 拼接后的正文 = 标记之前的正文（去掉尾部空白），不含任何标记字符
//   3. tool_calls、finish_reason、usage 与输入逐项相等
//   4. 不含标记的流（P04）经过滤后逐字节不变
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRawToolMarkupFilter } = await import(join(DIR, '..', '06-webui-tunnel', 'src', 'lib', 'proxies.mjs'))
const { summarize } = await import('./bedrock.mjs')

const toSse = (events) => events.map((e) => `data: ${e.data === '[DONE]' ? '[DONE]' : JSON.stringify(e.data)}\n\n`).join('')
const parse = (s) => s.split('\n\n').filter(Boolean).map((f) => { const d = f.slice(6); return { data: d === '[DONE]' ? d : JSON.parse(d) } })
function chunked(buf, rnd) { const out = []; let i = 0; while (i < buf.length) { const n = 1 + Math.floor(rnd() * 40); out.push(buf.subarray(i, i + n)); i += n } return out }
let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)

let fails = 0
const files = readdirSync(join(DIR, 'results', 'probe-events')).filter((f) => f.endsWith('.json'))
for (const f of files) {
  const events = JSON.parse(readFileSync(join(DIR, 'results', 'probe-events', f), 'utf8'))
  const input = Buffer.from(toSse(events))
  const before = summarize(events)
  const hasMark = /<｜/.test(before.text)
  const expectText = hasMark ? before.text.slice(0, before.text.indexOf('<｜')).replace(/\s+$/, '') : before.text
  for (let k = 0; k < 500; k++) {
    const flt = createRawToolMarkupFilter()
    let out = ''
    for (const c of chunked(input, rnd)) out += flt.push(c)
    out += flt.end()
    const after = parse(out)
    const s = summarize(after)
    const ok = after.length === events.length && s.text === expectText && !/<｜/.test(s.text)
      && JSON.stringify(s.toolCalls) === JSON.stringify(before.toolCalls) && s.finish === before.finish && JSON.stringify(s.usage) === JSON.stringify(before.usage)
      && (hasMark || out === input.toString())
    if (!ok) { fails++; console.log(`✗ ${f} run ${k}: text「${s.text.slice(-60)}」 expected「${expectText.slice(-60)}」 frames ${after.length}/${events.length}`); break }
  }
  console.log(`${f}: 标记=${hasMark} 正文「${expectText.replace(/\s+/g, ' ').slice(0, 50)}」 ${fails ? '' : '500/500 ✓'}`)
}
console.log(fails ? `${fails} file(s) failed` : 'all passed')
process.exit(fails ? 1 : 0)

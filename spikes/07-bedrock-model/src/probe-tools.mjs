// 工具调用专项：两个端点面 × 可用的 DeepSeek 模型，各重复 N 次，统计
//   - 是否得到结构化 tool_calls 且参数为合法 JSON、finish_reason=tool_calls
//   - content 中是否泄漏 DeepSeek 原始工具调用标记（<｜DSML｜…、<｜tool▁calls…）
//   - 首字节耗时
// 用法：node src/probe-tools.mjs [region] [N]  → results/probe-tools.jsonl

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readSse, summarize } from './bedrock.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const region = process.argv[2] ?? 'us-east-1'
const N = Number(process.argv[3] ?? 3)
const template = JSON.parse(readFileSync(join(DIR, 'fixtures', 'dsh-request-template.json'), 'utf8'))
const LEAK = /<｜(DSML|tool)|<\|(DSML|tool)|function_calls|tool▁call/
const prompts = [
  '请调用 bash 工具执行命令 `echo spike07`，然后告诉我输出。',
  '在当前目录创建文件 hello.txt，内容是 spike07。',
  '列出当前目录下的文件。',
]
const combos = [
  ['bedrock-runtime', 'deepseek.v3.2'],
  ['bedrock-mantle', 'deepseek.v3.2'],
  ['bedrock-mantle', 'deepseek.v3.1'],
]
const rows = []
for (const [surface, model] of combos) {
  const c = makeClient({ region, surface, service: surface === 'bedrock-mantle' ? 'bedrock-mantle' : 'bedrock' })
  for (let i = 0; i < N; i++) {
    const prompt = prompts[i % prompts.length]
    const t0 = Date.now()
    const r = await c.request('POST', '/chat/completions', { ...template, model, messages: [template.messages[0], { role: 'user', content: prompt }] })
    if (r.status !== 200) { const row = { surface, model, i, status: r.status, error: (await r.text()).slice(0, 300) }; rows.push(row); console.log(JSON.stringify(row)); continue }
    const sse = await readSse(r, t0)
    const s = summarize(sse.events)
    let argsJson = false
    try { argsJson = s.toolCalls.length > 0 && s.toolCalls.every((t) => JSON.parse(t.args) && t.name) } catch { /* 非法 JSON */ }
    const row = { surface, model, i, prompt, status: 200, firstByteMs: sse.firstByteMs, totalMs: sse.totalMs, finish: s.finish, tools: s.toolCalls.map((t) => t.name), argsJson, leak: LEAK.test(s.text), text: s.text.slice(0, 200), textChunks: s.textChunks, deltaKeys: s.deltaKeys }
    rows.push(row)
    console.log(`${surface} ${model} #${i} finish=${row.finish} tools=${row.tools.join(',') || '-'} argsJson=${argsJson} leak=${row.leak} fb=${row.firstByteMs}ms text=「${row.text.replace(/\s+/g, ' ').slice(0, 80)}」`)
  }
}
writeFileSync(join(DIR, 'results', 'probe-tools.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')

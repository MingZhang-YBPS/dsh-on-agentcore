// 探针：用 DSH 实际发出的请求形态（Spike 05 录下的 system 提示词 + 23 个工具 + 请求字段）直接调用 Bedrock 的
// OpenAI 兼容端点，逐项记录可用性、SSE 片段格式、工具调用增量格式、reasoning 字段、错误形态。
// 用法：node src/probe.mjs [region]  → results/probe-cases.jsonl、results/probe-events/*.json

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readSse, summarize } from './bedrock.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = join(DIR, 'results'); mkdirSync(join(RESULTS, 'probe-events'), { recursive: true })
const region = process.argv[2] ?? 'us-east-1'
const template = JSON.parse(readFileSync(join(DIR, 'fixtures', 'dsh-request-template.json'), 'utf8'))
const rows = []
const record = (r) => { rows.push(r); console.log(`${r.pass ? '✓' : '✗'} ${r.id} ${r.desc} — ${r.note ?? ''}`) }
const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

const dshBody = (model, messages, extra = {}) => ({ ...template, model, messages: [template.messages[0], ...messages], ...extra })

async function chatStream(client, body, tag) {
  const t0 = Date.now()
  const r = await client.request('POST', '/chat/completions', body)
  if (r.status !== 200) return { status: r.status, error: short(await r.text(), 400) }
  const sse = await readSse(r, t0)
  writeFileSync(join(RESULTS, 'probe-events', `${tag}.json`), JSON.stringify(sse.events, null, 1))
  return { status: 200, ct: r.headers.get('content-type'), ...sse, sum: summarize(sse.events) }
}

async function run(id, desc, fn) {
  try { record({ id, desc, ...(await fn()) }) } catch (e) { record({ id, desc, pass: false, note: `${e.name}: ${e.message}` }) }
}

const rt = makeClient({ region, surface: 'bedrock-runtime' })

await run('P01', 'bedrock-runtime：GET /openai/v1/models 列出可用模型', async () => {
  const r = await rt.request('GET', '/models')
  const t = await r.text()
  let ids = []
  try { ids = JSON.parse(t).data.map((m) => m.id) } catch { /* 非 JSON */ }
  return { pass: r.status === 200, status: r.status, deepseek: ids.filter((i) => /deepseek/i.test(i)), note: `${r.status}；DeepSeek：${ids.filter((i) => /deepseek/i.test(i)).join(', ') || short(t)}` }
})

for (const model of ['deepseek.v3.2', 'us.deepseek.r1-v1:0', 'deepseek.r1-v1:0']) {
  const tag = model.replace(/[^a-z0-9]+/gi, '_')
  await run(`P02:${model}`, `${model}：DSH 完整请求体（23 个工具 + store/max_completion_tokens/stream_options）流式文本回复`, async () => {
    const r = await chatStream(rt, dshBody(model, [{ role: 'user', content: '用一句中文打个招呼，不要调用任何工具。' }]), `P02-${tag}`)
    if (r.status !== 200) return { pass: false, status: r.status, note: `${r.status} ${r.error}` }
    const s = r.sum
    return {
      pass: s.text.length > 0 && s.done, status: 200, contentType: r.ct, firstByteMs: r.firstByteMs, totalMs: r.totalMs,
      textChunks: s.textChunks, reasoningChunks: s.reasoningChunks, deltaKeys: s.deltaKeys, chunkKeys: s.chunkKeys, finish: s.finish, usage: s.usage,
      note: `首字节 ${r.firstByteMs} ms，共 ${r.totalMs} ms；正文片段 ${s.textChunks}、推理片段 ${s.reasoningChunks}；delta 字段 ${s.deltaKeys.join('/')}；finish=${s.finish}；usage=${s.usage ? 'yes' : 'no'}；「${short(s.text, 60)}」`,
    }
  })
}

// 工具调用往返：第一轮要求用 bash 执行命令 → 解析增量 tool_calls → 回灌 tool 结果 → 第二轮给出最终回复
for (const model of ['deepseek.v3.2', 'us.deepseek.r1-v1:0']) {
  const tag = model.replace(/[^a-z0-9]+/gi, '_')
  let first = null
  await run(`P03:${model}`, `${model}：流式工具调用（bash），增量 tool_calls 可拼接成合法 JSON 参数`, async () => {
    const r = await chatStream(rt, dshBody(model, [{ role: 'user', content: '请调用 bash 工具执行命令 `echo spike07`，然后告诉我输出。' }]), `P03-${tag}`)
    if (r.status !== 200) return { pass: false, status: r.status, note: `${r.status} ${r.error}` }
    const s = r.sum
    first = s
    let argsOk = false
    try { argsOk = s.toolCalls.length > 0 && typeof JSON.parse(s.toolCalls[0].args).command === 'string' } catch { /* 参数不是 JSON */ }
    return {
      pass: argsOk && s.finish === 'tool_calls', toolCalls: s.toolCalls, toolArgChunks: s.toolArgChunks, finish: s.finish, deltaKeys: s.deltaKeys,
      note: `tool_calls=${JSON.stringify(s.toolCalls).slice(0, 160)}；参数片段 ${s.toolArgChunks}；finish=${s.finish}；正文「${short(s.text, 40)}」`,
    }
  })
  await run(`P04:${model}`, `${model}：回灌 role=tool 结果后得到最终回复`, async () => {
    if (!first?.toolCalls?.length) return { pass: false, note: '上一轮没有工具调用，跳过' }
    const tc = first.toolCalls[0]
    const msgs = [
      { role: 'user', content: '请调用 bash 工具执行命令 `echo spike07`，然后告诉我输出。' },
      { role: 'assistant', content: first.text || null, tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }] },
      { role: 'tool', tool_call_id: tc.id, content: 'spike07\n[exit code: 0]' },
    ]
    const r = await chatStream(rt, dshBody(model, msgs), `P04-${tag}`)
    if (r.status !== 200) return { pass: false, status: r.status, note: `${r.status} ${r.error}` }
    return { pass: r.sum.text.includes('spike07') && r.sum.finish === 'stop', finish: r.sum.finish, note: `finish=${r.sum.finish}；「${short(r.sum.text, 80)}」` }
  })
}

await run('P05', '错误形态：不存在的模型 ID', async () => {
  const r = await rt.request('POST', '/chat/completions', dshBody('deepseek.not-a-model', [{ role: 'user', content: 'hi' }]))
  const t = await r.text()
  return { pass: r.status >= 400 && r.status < 500, status: r.status, body: short(t, 300), note: `${r.status} ${short(t, 200)}` }
})

await run('P06', '错误形态：流式中途客户端取消（模拟停止生成）→ 连接关闭且不报错', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  const r = await rt.request('POST', '/chat/completions', dshBody('deepseek.v3.2', [{ role: 'user', content: '从 1 数到 200，每个数字一行。' }]), { signal: ac.signal })
  let n = 0
  try { for await (const _ of r.body) { if (++n === 5) ac.abort() } } catch (e) { return { pass: e.name === 'AbortError', note: `第 ${n} 块后取消，${Date.now() - t0} ms，${e.name}` } }
  return { pass: false, note: '流在取消前已结束' }
})

// bedrock-mantle 端点面：签名服务名未知，两种都试
for (const service of ['bedrock-mantle', 'bedrock']) {
  const mt = makeClient({ region, surface: 'bedrock-mantle', service })
  await run(`P07:${service}`, `bedrock-mantle 端点面，SigV4 服务名 ${service}：列模型 + deepseek.v3.2 流式文本`, async () => {
    const lm = await mt.request('GET', '/models')
    const lt = await lm.text()
    let ids = []
    try { ids = JSON.parse(lt).data.map((m) => m.id) } catch { /* 非 JSON */ }
    const r = await chatStream(mt, dshBody('deepseek.v3.2', [{ role: 'user', content: '用一句中文打个招呼，不要调用任何工具。' }]), `P07-${service}`)
    return {
      pass: lm.status === 200 && r.status === 200 && r.sum?.text?.length > 0,
      note: `models ${lm.status}（DeepSeek：${ids.filter((i) => /deepseek/i.test(i)).join(', ') || short(lt, 120)}）；chat ${r.status} ${r.status === 200 ? `「${short(r.sum.text, 40)}」 delta=${r.sum.deltaKeys.join('/')}` : r.error}`,
    }
  })
}

writeFileSync(join(RESULTS, 'probe-cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
console.log(`\n${rows.length} cases, ${rows.filter((x) => !x.pass).length} not as expected`)

// 直接用 SigV4 调用 Bedrock 的 OpenAI 兼容端点（与 DSH 签名代理同一签名方式），供探针用例使用。

import { createHash } from 'node:crypto'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

export const SURFACES = {
  'bedrock-runtime': (region) => `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
  'bedrock-mantle': (region) => `https://bedrock-mantle.${region}.api.aws/v1`,
}

export function makeClient({ region, surface = 'bedrock-runtime', service = 'bedrock', credentials = defaultProvider() }) {
  const base = SURFACES[surface](region)
  const signer = new SignatureV4({ service, region, credentials, sha256: Hash.bind(null, 'sha256') })
  async function request(method, path, json, { signal } = {}) {
    const u = new URL(base + path)
    const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json))
    const headers = { host: u.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') }
    const signed = await signer.sign({ method, protocol: u.protocol, hostname: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body })
    const out = { ...signed.headers }
    delete out.host
    return fetch(u, { method, headers: out, body: body.length ? body : undefined, signal })
  }
  return { base, request }
}

// 读取 SSE 流，返回解析后的 data 事件（[DONE] 记为字符串）与首字节耗时
export async function readSse(res, t0 = Date.now()) {
  const events = []
  let firstByteMs = null
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of res.body) {
    if (firstByteMs === null) firstByteMs = Date.now() - t0
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const d = line.slice(5).trim()
        events.push({ at: Date.now() - t0, data: d === '[DONE]' ? d : JSON.parse(d) })
      }
    }
  }
  return { events, firstByteMs, totalMs: Date.now() - t0 }
}

// 汇总流事件：正文、推理内容、工具调用（按 index 拼接参数）、finish_reason、usage、出现过的 delta 字段
export function summarize(events) {
  const s = { text: '', reasoning: '', toolCalls: [], finish: null, usage: null, deltaKeys: new Set(), chunkKeys: new Set(), done: false, textChunks: 0, reasoningChunks: 0, toolArgChunks: 0 }
  for (const { data } of events) {
    if (data === '[DONE]') { s.done = true; continue }
    Object.keys(data).forEach((k) => s.chunkKeys.add(k))
    if (data.usage) s.usage = data.usage
    for (const c of data.choices ?? []) {
      const d = c.delta ?? {}
      Object.keys(d).forEach((k) => s.deltaKeys.add(k))
      if (d.content) { s.text += d.content; s.textChunks++ }
      if (d.reasoning_content) { s.reasoning += d.reasoning_content; s.reasoningChunks++ }
      if (d.reasoning) { s.reasoning += d.reasoning; s.reasoningChunks++ }
      for (const tc of d.tool_calls ?? []) {
        const slot = (s.toolCalls[tc.index ?? 0] ??= { id: null, name: '', args: '' })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) { slot.args += tc.function.arguments; s.toolArgChunks++ }
      }
      if (c.finish_reason) s.finish = c.finish_reason
    }
  }
  s.deltaKeys = [...s.deltaKeys]; s.chunkKeys = [...s.chunkKeys]
  return s
}

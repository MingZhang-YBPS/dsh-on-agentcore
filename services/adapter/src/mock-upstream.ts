// 模拟 OpenAI 兼容 Chat Completions 上游（测试用，MOCK_MODEL=1 时由适配器在容器内启动）。
// 按最后一条带标记的用户消息决定行为，并记录每个请求（凭证值打码）供测试核对：
//   [[TEXT]]         reasoning_content 2 片 + content 5 片（「你好，这是模拟回复。」）
//   [[TOOL]]         首次返回 bash 工具调用（参数分 3 片）；收到工具结果后返回「工具已执行完毕。」
//   [[SLOW]]         100 片 content，每片间隔 100 ms（用于停止生成）
//   [[BIG]]          一段约 80 KB 的正文（用于 WebSocket 帧上限回归）
//   [[SEARCH]]       首次返回 web_search 工具调用；收到工具结果后回复「搜索已完成：<结果里是否有模拟来源>」
// 另外模拟 DeepSeek 搜索端点 POST /anthropic/v1/messages（Anthropic Messages + web_search 服务端工具的响应形状），
// 只记录 x-api-key 的 sha256，便于测试核对注入的 key。

import http from 'node:http'
import { createHash } from 'node:crypto'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MARK = /\[\[(TEXT|TOOL|SLOW|BIG|SEARCH)\]\]/
export const MOCK_SEARCH_URL = 'https://dsh-e2e.example/result'

interface Msg { role: string; content?: unknown }
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('')
  return ''
}

export interface MockRequest {
  at: number
  method: string
  url: string
  headers: Record<string, unknown>
  sigv4: { scheme: string | null; credentialScope: string | null; contentSha256Matches: boolean }
  body: { model?: string; messages?: Msg[]; tools?: { function?: { name?: string } }[] } | null
  /** DeepSeek 搜索请求：x-api-key 的 sha256（不记录原值） */
  searchKeySha256?: string
  /** Authorization: Bearer 值的 sha256（DeepSeek 官方模型经 DeepSeek 代理时由代理注入；不记录原值） */
  bearerSha256?: string
  clientClosedEarly: boolean
}

export async function startMockUpstream(): Promise<{ server: http.Server; base: string; requests: MockRequest[]; close(): Promise<void> }> {
  const requests: MockRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => { void handle(Buffer.concat(chunks)) })
    async function handle(raw: Buffer): Promise<void> {
      let body: MockRequest['body'] = null
      try { body = JSON.parse(raw.toString('utf8')) as MockRequest['body'] } catch { /* 非 JSON */ }
      const auth = String(req.headers.authorization ?? '')
      const rec: MockRequest = {
        at: Date.now(), method: req.method ?? '', url: req.url ?? '',
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, /authorization|security-token|api-key/i.test(k) ? `<${String(v).length} chars>` : v])),
        sigv4: {
          scheme: auth.split(' ')[0] || null,
          credentialScope: /Credential=[^/]+\/\d{8}\/([^,]+)/.exec(auth)?.[1] ?? null,
          contentSha256Matches: req.headers['x-amz-content-sha256'] === createHash('sha256').update(raw).digest('hex'),
        },
        body, clientClosedEarly: false,
        ...(auth.startsWith('Bearer ') ? { bearerSha256: createHash('sha256').update(auth.slice(7)).digest('hex') } : {}),
      }
      requests.push(rec)
      req.socket.on('close', () => { if (!res.writableEnded) rec.clientClosedEarly = true })
      if (req.method === 'POST' && (req.url ?? '').endsWith('/anthropic/v1/messages')) {
        rec.searchKeySha256 = createHash('sha256').update(String(req.headers['x-api-key'] ?? '')).digest('hex')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'mock' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: MOCK_SEARCH_URL, title: 'DSH E2E mock result', page_age: '2026-09-27' }] },
            { type: 'text', text: 'mock', citations: [{ type: 'web_search_result_location', url: MOCK_SEARCH_URL, title: 'DSH E2E mock result', cited_text: 'mock search snippet' }] },
          ],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        }))
        return
      }
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions') || !body) {
        res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found' } })); return
      }
      const msgs = body.messages ?? []
      const last = msgs.at(-1)
      const marked = [...msgs].reverse().find((m) => m.role === 'user' && MARK.test(textOf(m.content)))
      const marker = MARK.exec(textOf(marked?.content))?.[1] ?? 'TEXT'
      const id = `chatcmpl-${requests.length}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const emit = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body?.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      const done = () => {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body?.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
      const names = (body.tools ?? []).map((t) => t.function?.name ?? '')
      const bash = names.find((n) => /^bash$/i.test(n)) ?? names.find((n) => /bash|shell/i.test(n)) ?? 'bash'
      try {
        if (marker === 'TOOL') {
          if (last?.role === 'tool') {
            for (const t of ['工具', '已执行', '完毕。']) { await sleep(20); emit({ content: t }) }
            emit({}, 'stop'); done(); return
          }
          const args = JSON.stringify({ command: 'echo spike05 > hello.txt && cat hello.txt && pwd', description: 'mock tool call' })
          emit({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: bash, arguments: '' } }] })
          for (const p of [args.slice(0, 10), args.slice(10, 30), args.slice(30)]) { await sleep(20); emit({ tool_calls: [{ index: 0, function: { arguments: p } }] }) }
          emit({}, 'tool_calls'); done(); return
        }
        if (marker === 'SEARCH') {
          if (last?.role === 'tool') {
            const found = textOf(last.content).includes(MOCK_SEARCH_URL)
            for (const t of ['搜索已完成：', found ? '找到模拟来源' : '没有结果']) { await sleep(20); emit({ content: t }) }
            emit({}, 'stop'); done(); return
          }
          const search = names.find((n) => /web_search/i.test(n)) ?? 'web_search'
          emit({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: search, arguments: JSON.stringify({ queries: ['dsh e2e mock search'] }) } }] })
          emit({}, 'tool_calls'); done(); return
        }
        if (marker === 'SLOW') {
          emit({ role: 'assistant', content: '' })
          for (let i = 0; i < 100 && !res.destroyed; i++) { await sleep(100); emit({ content: `片${i} ` }) }
          emit({}, 'stop'); done(); return
        }
        if (marker === 'BIG') {
          emit({ role: 'assistant', content: '' })
          for (let i = 0; i < 40; i++) emit({ content: `第${i}段：${'大消息'.repeat(700)}\n` })
          emit({ content: '大消息结束。' })
          emit({}, 'stop'); done(); return
        }
        emit({ role: 'assistant', reasoning_content: '先想一想，' })
        await sleep(20)
        emit({ reasoning_content: '再回答。' })
        for (const t of ['你好', '，', '这是', '模拟', '回复。']) { await sleep(30); emit({ content: t }) }
        emit({}, 'stop'); done()
      } catch { /* 客户端提前断开 */ }
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, requests, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

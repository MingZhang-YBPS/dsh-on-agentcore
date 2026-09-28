// 模拟 OpenAI 兼容 Chat Completions 上游（代替 Bedrock），按最后一条用户消息里的标记决定行为，
// 并记录每个请求（请求头去掉凭证值、请求体完整）供事后核对 DSH 实际发出了什么。
//   [[TEXT]]       reasoning_content 2 片 + content 5 片
//   [[TOOL]]       首次返回 bash 工具调用（参数分 3 片）；收到工具结果后返回一段文本
//   [[SLOW]]       100 片 content，每片间隔 100 ms（用于流式中途取消）
//   [[SLEEPTOOL]]  返回会长时间运行的 bash 工具调用（用于工具执行中途取消）
//   [[STUBBORNTOOL]] 返回忽略 SIGTERM 的 bash 工具调用（用于验证 SIGKILL 升级）

import http from 'node:http'
import { createHash } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text ?? '')).join('')
  return ''
}

export async function startMockUpstream({ model, onRequest }) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks)
      let body = null
      try { body = JSON.parse(raw.toString('utf8')) } catch { /* 非 JSON */ }
      const auth = req.headers.authorization ?? ''
      const record = {
        at: Date.now(),
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) =>
          [k, /authorization|security-token/i.test(k) ? `<${String(v).length} chars>` : v])),
        sigv4: {
          scheme: auth.split(' ')[0] || null,
          credentialScope: /Credential=[^/]+\/\d{8}\/([^,]+)/.exec(auth)?.[1] ?? null,
          signedHeaders: /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? null,
          contentSha256Matches: req.headers['x-amz-content-sha256'] === createHash('sha256').update(raw).digest('hex'),
          hasAmzDate: Boolean(req.headers['x-amz-date']),
        },
        body,
        clientClosedEarly: false,
      }
      requests.push(record)
      onRequest?.(record)
      req.socket.on('close', () => { if (!res.writableEnded) record.clientClosedEarly = true })

      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions') || !body) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      const msgs = body.messages ?? []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const last = msgs.at(-1)
      // DSH 会在用户消息之后追加「运行时上下文」等注入消息，所以从后往前找第一条带标记的用户消息
      const marked = [...msgs].reverse().find((m) => m.role === 'user' && /\[\[(TEXT|TOOL|SLOW|SLEEPTOOL|STUBBORNTOOL)\]\]/.test(textOf(m.content)))
      const marker = /\[\[(TEXT|TOOL|SLOW|SLEEPTOOL|STUBBORNTOOL)\]\]/.exec(textOf(marked?.content))?.[1] ?? 'TEXT'
      const id = `chatcmpl-${requests.length}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': id })
      const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`)
      const done = () => {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
      const bashTool = (body.tools ?? []).map((t) => t.function?.name).find((n) => /^bash$/i.test(n ?? ''))
        ?? (body.tools ?? []).map((t) => t.function?.name).find((n) => /bash|shell/i.test(n ?? ''))
      const toolCall = async (command) => {
        const args = JSON.stringify({ command, description: 'spike05 tool call' })
        const parts = [args.slice(0, 10), args.slice(10, 30), args.slice(30)]
        emit({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: bashTool, arguments: '' } }] })
        for (const p of parts) { await sleep(20); emit({ tool_calls: [{ index: 0, function: { arguments: p } }] }) }
        emit({}, 'tool_calls')
        done()
      }

      try {
        if (marker === 'TOOL' || marker === 'SLEEPTOOL' || marker === 'STUBBORNTOOL') {
          if (last?.role === 'tool') {
            for (const t of ['工具', '已执行', '完毕。']) { await sleep(20); emit({ content: t }) }
            emit({}, 'stop')
            done()
          } else if (marker === 'TOOL') {
            await toolCall('echo spike05 > hello.txt && mkdir -p sub/dir && cat hello.txt && pwd')
          } else if (marker === 'STUBBORNTOOL') {
            // 忽略 SIGTERM 的工具：SIG_IGN 跨 exec 继承，sleep 63 同样忽略 SIGTERM，只能靠 SIGKILL
            await toolCall("trap '' TERM ; sleep 63 ; echo finished")
          } else {
            // 前台进程 sleep 61，外加一个后台孙进程 sleep 62，二者都在工具的进程组内
            await toolCall('(sleep 62 &) ; sleep 61 ; echo finished')
          }
          return
        }
        if (marker === 'SLOW') {
          emit({ role: 'assistant', content: '' })
          for (let i = 0; i < 100 && !res.destroyed; i++) { await sleep(100); emit({ content: `片${i} ` }) }
          emit({}, 'stop')
          done()
          return
        }
        emit({ role: 'assistant', reasoning_content: '先想一想，' })
        await sleep(20)
        emit({ reasoning_content: '再回答。' })
        for (const t of ['你好', '，', '这是', '模拟', '回复。']) { await sleep(30); emit({ content: t }) }
        emit({}, 'stop')
        done()
      } catch {
        // 客户端提前断开
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, requests, base: `http://127.0.0.1:${server.address().port}`, model }
}

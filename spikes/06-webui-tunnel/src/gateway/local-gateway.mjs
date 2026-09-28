// 浏览器一侧的网关（本机验证用，代替 CloudFront + Lambda）。浏览器打开 http://localhost:GATEWAY_PORT/ 即可使用官方 Web UI。
//   普通 HTTP 请求 → 封包 → POST /invocations（local 模式直连适配器；agentcore 模式调用 InvokeAgentRuntime）
//   WebSocket /api/remote.mux → 适配器 /ws（local）或 AgentCore Runtime 的 /ws（agentcore，阶段 2 实现）
//
// 环境变量：GATEWAY_PORT=8000  MODE=local|agentcore  ADAPTER_URL=http://127.0.0.1:8080
//           （agentcore 模式）RUNTIME_ARN  RUNTIME_SESSION_ID  AWS_REGION

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { encodeRequest, decodeResponseStream, HOP_HEADERS } from '../lib/envelope.mjs'

export async function startGateway({ port = 0, mode = 'local', adapterUrl = 'http://127.0.0.1:8080', transport } = {}) {
  const stats = { http: 0, ws: 0, errors: 0, perRequestMs: [] }
  const tx = transport ?? localTransport(adapterUrl)

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', async () => {
      const t0 = Date.now()
      stats.http++
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v
      try {
        const body = await tx.invoke(encodeRequest({ method: req.method, path: req.url, headers, body: Buffer.concat(chunks) }))
        const { head, rest } = await decodeResponseStream(body)
        res.writeHead(head.status, head.headers)
        for await (const c of rest) res.write(c)
        res.end()
        stats.perRequestMs.push({ path: req.url.split('?')[0], status: head.status, ms: Date.now() - t0 })
      } catch (e) {
        stats.errors++
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`gateway error: ${e.message}`)
      }
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/api/remote.mux') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, async (client) => {
      stats.ws++
      let upstream
      try { upstream = await tx.openWebSocket() } catch (e) { stats.errors++; client.close(1011, 'upstream ws failed'); return }
      const pending = []
      const flush = () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }) }
      if (upstream.readyState === WebSocket.OPEN) flush(); else upstream.on('open', flush)
      client.on('message', (d, b) => (upstream.readyState === WebSocket.OPEN ? upstream.send(d, { binary: b }) : pending.push([d, b])))
      upstream.on('message', (d, b) => client.readyState === WebSocket.OPEN && client.send(d, { binary: b }))
      const closeBoth = (code, reason) => {
        const c = typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011
        if (client.readyState <= WebSocket.OPEN) client.close(c, reason)
        if (upstream.readyState <= WebSocket.OPEN) upstream.close(c, reason)
      }
      client.on('close', closeBoth)
      upstream.on('close', closeBoth)
      upstream.on('error', () => closeBoth(1011))
      client.on('error', () => closeBoth(1011))
    })
  })

  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { server, stats, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port }
}

// local 模式：直接 POST 到适配器的 /invocations 与 /ws
export function localTransport(adapterUrl) {
  return {
    async invoke(payload) {
      const r = await fetch(`${adapterUrl}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
      if (r.status !== 200) throw new Error(`adapter /invocations returned ${r.status}`)
      return r.body
    },
    async openWebSocket() {
      return new WebSocket(`${adapterUrl.replace(/^http/, 'ws')}/ws`, { perMessageDeflate: false })
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let transport
  if ((process.env.MODE ?? 'local') === 'agentcore') {
    const { agentcoreTransport } = await import('./agentcore-transport.mjs')
    transport = agentcoreTransport({ runtimeArn: process.env.RUNTIME_ARN, sessionId: process.env.RUNTIME_SESSION_ID, region: process.env.AWS_REGION ?? 'us-east-1' })
  }
  const g = await startGateway({ port: Number(process.env.GATEWAY_PORT ?? 8000), adapterUrl: process.env.ADAPTER_URL ?? 'http://127.0.0.1:8080', transport })
  console.log(`gateway listening on ${g.base}`)
}

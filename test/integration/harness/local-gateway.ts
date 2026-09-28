// 浏览器一侧的本机网关（代替 CloudFront + 隧道 Lambda）：普通 HTTP 请求封包后 POST 到适配器 /invocations，
// WebSocket /api/remote.mux 对接适配器 /ws。本机测试不做登录与会话归属校验（适配器以 REQUIRE_SESSION_OWNER=0 运行）。

import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { HOP_HEADERS, decodeResponseStream, encodeRequest, type Headers } from '@dsh-poc/envelope'

export interface GatewayStats { http: number; ws: number; errors: number; perRequest: { path: string; status: number; ms: number }[] }

export async function startLocalGateway({ port = 0, adapterUrl }: { port?: number; adapterUrl: string }): Promise<{ server: http.Server; port: number; base: string; stats: GatewayStats; close(): Promise<void> }> {
  const stats: GatewayStats = { http: 0, ws: 0, errors: 0, perRequest: [] }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      void (async () => {
        const t0 = Date.now()
        stats.http++
        const headers: Headers = {}
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) headers[k] = v
        try {
          const r = await fetch(`${adapterUrl}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encodeRequest({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks) }) })
          if (r.status !== 200 || !r.body) throw new Error(`adapter /invocations returned ${r.status}`)
          const { head, rest } = await decodeResponseStream(r.body as unknown as AsyncIterable<Uint8Array>)
          res.writeHead(head.status, head.headers)
          for await (const c of rest) res.write(c)
          res.end()
          stats.perRequest.push({ path: (req.url ?? '/').split('?')[0] as string, status: head.status, ms: Date.now() - t0 })
        } catch (e) {
          stats.errors++
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`gateway error: ${(e as Error).message}`)
        }
      })()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/api/remote.mux') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (client) => {
      stats.ws++
      const upstream = new WebSocket(`${adapterUrl.replace(/^http/, 'ws')}/ws`, { perMessageDeflate: false })
      const pending: [Buffer, boolean][] = []
      upstream.on('open', () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }) })
      client.on('message', (d: Buffer, b: boolean) => (upstream.readyState === WebSocket.OPEN ? upstream.send(d, { binary: b }) : pending.push([d, b])))
      upstream.on('message', (d: Buffer, b: boolean) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: b }) })
      const closeBoth = (code?: number) => {
        const c = typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011
        if (client.readyState <= WebSocket.OPEN) client.close(c)
        if (upstream.readyState <= WebSocket.OPEN) upstream.close(c)
      }
      client.on('close', closeBoth)
      upstream.on('close', closeBoth)
      upstream.on('error', () => closeBoth(1011))
      client.on('error', () => closeBoth(1011))
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const p = (server.address() as { port: number }).port
  return { server, port: p, base: `http://127.0.0.1:${p}`, stats, close: () => new Promise<void>((r) => { wss.close(); server.closeAllConnections(); server.close(() => r()) }) }
}

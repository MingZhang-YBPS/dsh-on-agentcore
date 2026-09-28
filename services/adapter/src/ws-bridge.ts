// /ws：AgentCore 一侧的 WebSocket ↔ dsh web 的 /api/remote.mux。
// - AgentCore /ws 空闲约 60 s 会断开：每 keepaliveMs 向 AgentCore 一侧发 ping（DSH 的 ping 只到适配器这一跳）；
// - AgentCore /ws 单帧上限 64 KB：发往 AgentCore 一侧的消息按 frameMax 分片（@dsh-poc/envelope fragment）；
// - 任一侧关闭时两侧一起关闭，并记录哪一侧先关闭、关闭码与原因。

import type http from 'node:http'
import { WebSocket } from 'ws'
import { fragment } from '@dsh-poc/envelope'
import type { Logger } from '@dsh-poc/log'

export interface BridgeOptions { authority: string; cookie: string; keepaliveMs: number; frameMax: number; log: Logger }

export function sendFragmented(ws: WebSocket, data: Buffer, binary: boolean, frameMax: number): number {
  const frames = fragment(data, frameMax)
  for (const f of frames) ws.send(f.data, { binary, fin: f.fin })
  return frames.length
}

const closeCode = (code: unknown): number => (typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011)

export function bridgeWebSocket(client: WebSocket, req: http.IncomingMessage, o: BridgeOptions): void {
  const upstream = new WebSocket(`ws://${o.authority}/api/remote.mux`, { headers: { cookie: o.cookie, host: o.authority }, perMessageDeflate: false })
  const pending: [Buffer, boolean][] = []
  const opened = Date.now()
  const counts = { fromClient: 0, fromDsh: 0, fragmented: 0 }
  let closedBy: 'client' | 'dsh' | null = null
  upstream.on('open', () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }) })
  const keepalive = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.ping() }, o.keepaliveMs)
  client.on('message', (d: Buffer, isBinary: boolean) => {
    counts.fromClient++
    if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: isBinary })
    else pending.push([d, isBinary])
  })
  upstream.on('message', (d: Buffer, isBinary: boolean) => {
    counts.fromDsh++
    if (client.readyState !== WebSocket.OPEN) return
    const n = sendFragmented(client, d, isBinary, o.frameMax)
    if (n > 1) { counts.fragmented++; o.log('debug', 'ws message fragmented', { bytes: d.length, frames: n }) }
  })
  const closeBoth = (code: unknown, reason?: Buffer | string): void => {
    clearInterval(keepalive)
    const c = closeCode(code)
    const r = String(reason ?? '').slice(0, 120)
    if (client.readyState <= WebSocket.OPEN) client.close(c, r)
    if (upstream.readyState <= WebSocket.OPEN) upstream.close(c, r)
  }
  const onClose = (side: 'client' | 'dsh') => (code: number, reason: Buffer) => {
    if (!closedBy) {
      closedBy = side
      o.log('info', 'ws closed', { closedBy: side, code, reason: reason.toString('utf8').slice(0, 120), lifetimeMs: Date.now() - opened, framesFromClient: counts.fromClient, framesFromDsh: counts.fromDsh, fragmentedMessages: counts.fragmented })
    }
    closeBoth(code, reason)
  }
  client.on('close', onClose('client'))
  upstream.on('close', onClose('dsh'))
  upstream.on('error', (e) => { o.log('warn', 'upstream ws error', { error: e.message }); closeBoth(1011, 'upstream error') })
  client.on('error', () => closeBoth(1011))
  o.log('info', 'ws bridged', { sessionId: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ?? null, hasBearer: /^Bearer /.test(req.headers.authorization ?? '') })
}

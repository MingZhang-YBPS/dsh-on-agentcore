// POST /invocations：请求体是封包后的浏览器 HTTP 请求；转发给 127.0.0.1 上的 dsh web，
// 响应以「元数据行 + 原始字节」流式写回。外层始终返回 200（外层非 200 会被 AgentCore 当作容器故障）。

import http from 'node:http'
import { decodeRequest, encodeResponseHead, type TunnelRequest } from '@dsh-poc/envelope'
import { fromDshHeaders, sessionOwnerRejection, toDshHeaders } from '@dsh-poc/session-identity'
import type { Logger } from '@dsh-poc/log'
import { rejectionBody, settingsRpcRejection } from './rpc-guard.js'
import { injectTransportHook, wantsHtml } from './html-inject.js'

export interface TunnelDeps {
  requireSessionOwner: boolean
  readyTimeoutMs: number
  /** DSH 就绪后返回 { authority, cookie }；超时抛错 */
  whenReady(timeoutMs: number): Promise<{ authority: string; cookie: string }>
  log: Logger
}

function innerReply(res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/octet-stream' })
  res.end(Buffer.concat([encodeResponseHead({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } }), Buffer.from(text)]))
}

export function handleInvocation(req: http.IncomingMessage, res: http.ServerResponse, deps: TunnelDeps): void {
  const chunks: Buffer[] = []
  req.on('data', (d: Buffer) => chunks.push(d))
  req.on('end', () => { void run(Buffer.concat(chunks)) })
  async function run(raw: Buffer): Promise<void> {
    const t0 = Date.now()
    let env: TunnelRequest
    try { env = decodeRequest(raw) } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `bad envelope: ${(e as Error).message}` }))
      return
    }
    if (deps.requireSessionOwner) {
      const rejection = sessionOwnerRejection(req.headers)
      if (rejection) { deps.log('warn', 'session owner check failed', { reason: rejection, path: env.path.slice(0, 120) }); innerReply(res, 403, 'forbidden'); return }
    }
    // 设置与凭证 RPC 的服务端过滤（rpc-guard.ts）：被拒绝的调用不转发给 DSH
    const rejected = settingsRpcRejection(env.method, env.path, env.body)
    if (rejected) {
      deps.log('info', 'settings rpc rejected', { path: env.path.split('?')[0]?.slice(0, 120), code: rejected.code, message: rejected.message })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.concat([encodeResponseHead({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), Buffer.from(rejectionBody(rejected))]))
      return
    }
    let dsh: { authority: string; cookie: string }
    try { dsh = await deps.whenReady(deps.readyTimeoutMs) } catch {
      deps.log('warn', 'dsh not ready, request rejected', { path: env.path.slice(0, 120), waitedMs: Date.now() - t0 })
      innerReply(res, 503, 'dsh starting', { 'retry-after': '1' })
      return
    }
    const [host, port] = dsh.authority.split(':')
    const headers = toDshHeaders(env.headers, dsh.authority, dsh.cookie)
    // 页面请求：要未压缩的 HTML，以便注入传输钩子（html-inject.ts）
    const html = wantsHtml(env.method, headers.accept)
    if (html) delete headers['accept-encoding']
    const up = http.request({ host, port: Number(port), method: env.method, path: env.path, headers }, (ur) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' })
      const ct = String(ur.headers['content-type'] ?? '')
      if (html && ur.statusCode === 200 && ct.startsWith('text/html') && !ur.headers['content-encoding']) {
        const parts: Buffer[] = []
        ur.on('data', (d: Buffer) => parts.push(d))
        ur.on('end', () => {
          const out = Buffer.from(injectTransportHook(Buffer.concat(parts).toString('utf8')), 'utf8')
          const h = fromDshHeaders(ur.headers)
          delete h['content-length']
          h['content-length'] = String(out.length)
          res.write(encodeResponseHead({ status: 200, headers: h }))
          res.end(out)
          deps.log('debug', 'invocation', { method: env.method, path: env.path.split('?')[0]?.slice(0, 120), status: 200, ms: Date.now() - t0, injected: true })
        })
        ur.on('error', () => res.destroy())
        return
      }
      res.write(encodeResponseHead({ status: ur.statusCode ?? 502, headers: fromDshHeaders(ur.headers) }))
      ur.on('data', (d: Buffer) => res.write(d))
      ur.on('end', () => {
        res.end()
        deps.log('debug', 'invocation', { method: env.method, path: env.path.split('?')[0]?.slice(0, 120), status: ur.statusCode, ms: Date.now() - t0 })
      })
      ur.on('error', () => res.destroy())
    })
    up.on('error', (e) => { deps.log('warn', 'dsh request failed', { error: e.message }); innerReply(res, 502, `adapter upstream error: ${e.message}`) })
    // 调用方断开（例如浏览器取消了一个长请求）时中止到 DSH 的请求
    res.on('close', () => { if (!res.writableEnded) up.destroy() })
    up.end(env.body)
  }
}

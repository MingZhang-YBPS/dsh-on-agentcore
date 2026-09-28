// SigV4 签名代理：只监听 127.0.0.1，DSH 的 llm-pi-ai openai-completions 路由的 baseURL 指向它。
// - 丢弃 DSH 发来的占位 Authorization，用执行角色临时凭证按 service/region 重新签名（含 x-amz-content-sha256）；
// - 把 DSH 请求路径中的 /openai/v1 前缀映射到 upstreamBase 的路径上（bedrock-runtime …/openai/v1、bedrock-mantle …/v1）；
// - SSE 响应逐帧流回，并执行原始工具调用标记过滤（@dsh-poc/model-stream）；
// - DSH 断开时中止上游请求；每次调用回调一条摘要（用于 model call 日志）。

import http from 'node:http'
import { createHash } from 'node:crypto'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'
import { createRawToolMarkupFilter } from '@dsh-poc/model-stream'

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'authorization'])
const LOCAL_PREFIX = '/openai/v1'

export interface ModelCallSummary {
  at: number
  method: string
  path: string
  bytesIn: number
  status: number | null
  ms: number
  cancelled: boolean
  strippedRawToolMarkup: number
  error?: string
  errorBody?: string
}

export interface SigningProxyOptions {
  upstreamBase: string
  region: string
  service?: string
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider
  stripRawToolMarkup?: boolean
  onCall?: (s: ModelCallSummary) => void
}

/** DSH 请求路径 → 上游 URL（upstreamBase 带路径时把本地前缀换成该路径；不带路径时原样拼接） */
export function upstreamUrl(upstreamBase: string, reqPath: string): URL {
  const up = new URL(upstreamBase)
  const basePath = up.pathname.replace(/\/$/, '')
  const target = basePath && reqPath.startsWith(LOCAL_PREFIX) ? basePath + reqPath.slice(LOCAL_PREFIX.length) : reqPath
  return new URL(target, up)
}

export async function startSigningProxy(opts: SigningProxyOptions): Promise<{ server: http.Server; base: string; close(): Promise<void> }> {
  const signer = new SignatureV4({ service: opts.service ?? 'bedrock', region: opts.region, credentials: opts.credentials, sha256: Hash.bind(null, 'sha256') })
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => { void handle(Buffer.concat(chunks)) })
    async function handle(body: Buffer): Promise<void> {
      const s: ModelCallSummary = { at: Date.now(), method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0] as string, bytesIn: body.length, status: null, ms: 0, cancelled: false, strippedRawToolMarkup: 0 }
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) { s.cancelled = true; ac.abort() } })
      try {
        const u = upstreamUrl(opts.upstreamBase, req.url ?? '/')
        const headers: Record<string, string> = { host: u.host }
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v
        headers['x-amz-content-sha256'] = createHash('sha256').update(body).digest('hex')
        const signed = await signer.sign({
          method: s.method, protocol: u.protocol, hostname: u.hostname, ...(u.port ? { port: Number(u.port) } : {}),
          path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body,
        })
        const out: Record<string, string> = { ...(signed.headers as Record<string, string>) }
        delete out.host
        const r = await fetch(u, { method: s.method, headers: out, ...(body.length ? { body } : {}), signal: ac.signal })
        s.status = r.status
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !HOP.has(k) && k !== 'content-encoding')))
        if (r.status !== 200) {
          // 错误响应体很小：整体读出后原样转发，并留一段摘要（区分 IAM 拒绝、模型不存在、参数错误）
          const t = await r.text()
          s.errorBody = t.slice(0, 300)
          res.write(t)
        } else if (r.body) {
          const isSse = (r.headers.get('content-type') ?? '').includes('text/event-stream')
          const filter = opts.stripRawToolMarkup !== false && isSse ? createRawToolMarkupFilter() : null
          for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(filter ? filter.push(chunk) : chunk)
          if (filter) { res.write(filter.end()); s.strippedRawToolMarkup = filter.stats.stripped }
        }
        res.end()
      } catch (e) {
        s.error = `${(e as Error).name}: ${(e as Error).message}`
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'signing proxy upstream error' } })) }
        else res.destroy()
      } finally {
        s.ms = Date.now() - s.at
        opts.onCall?.(s)
      }
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

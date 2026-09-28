// DeepSeek 官方 API 的本地代理：只监听 127.0.0.1，DSH 的 llm-deepseek（对话模型）与 web-search-deepseek（网页搜索）的 baseURL 指向它。
// - 只放行这两个插件用到的端点（ALLOWED）：POST /chat/completions、Files API（图片输入）、POST /anthropic/v1/messages；
// - 丢弃 DSH 发来的占位 x-api-key / Authorization，换成部署配置的 DeepSeek API key；
// - key 来自 Secrets Manager（执行角色读取，按 keyCacheMs 缓存；上游 401 时作废缓存重读一次），不进入 DSH 进程；
// - 每次调用回调一条摘要（用于 deepseek call 日志）。
// 注意：这只让 key 不出现在 DSH 的配置、环境与设置文件里；拥有 bash 的用户仍可直接调用本代理或用执行角色读取 secret。

import http from 'node:http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'

export const DEEPSEEK_SEARCH_PATH = '/anthropic/v1/messages'
/** 放行的方法与路径：llm-deepseek 的 chat/completions 与 Files API（packages/llm/llm-deepseek/src/adapter.ts、files-api.ts），网页搜索的 Messages 调用 */
const ALLOWED: readonly [string, RegExp][] = [
  ['POST', /^\/chat\/completions$/],
  ['POST', /^\/files$/],
  ['GET', /^\/files$/],
  ['GET', /^\/files\/[^/]+$/],
  ['DELETE', /^\/files\/[^/]+$/],
  ['POST', /^\/anthropic\/v1\/messages$/],
]
export const isAllowedDeepSeekCall = (method: string, path: string): boolean => ALLOWED.some(([m, re]) => m === method && re.test(path))
const DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'authorization', 'x-api-key', 'content-encoding'])

export interface DeepSeekCallSummary { at: number; method: string; path: string; bytesIn: number; status: number | null; ms: number; cancelled: boolean; keyConfigured: boolean; error?: string; errorBody?: string }

/** DeepSeek API key 的来源：get() 返回 undefined 表示部署未配置 */
export interface KeySource { get(): Promise<string | undefined>; invalidate(): void }

/** secret 的占位值（部署时创建 secret 用的初始值）视为未配置 */
export const UNCONFIGURED = 'not-configured'

export function staticKeySource(key: string | undefined): KeySource {
  return { get: async () => (key && key !== UNCONFIGURED ? key : undefined), invalidate: () => {} }
}

export interface SecretKeySourceOptions {
  secretArn: string
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider
  cacheMs: number
  /** 测试用：覆盖 Secrets Manager 端点 */
  endpoint?: string
}

/** 用执行角色凭证以 SigV4 直接调用 Secrets Manager GetSecretValue（不引入额外 SDK） */
export function secretKeySource(o: SecretKeySourceOptions): KeySource {
  const region = o.secretArn.split(':')[3]
  if (!region) throw new Error('DEEPSEEK_KEY_SECRET_ARN is not a Secrets Manager ARN')
  const endpoint = new URL(o.endpoint ?? `https://secretsmanager.${region}.amazonaws.com/`)
  const signer = new SignatureV4({ service: 'secretsmanager', region, credentials: o.credentials, sha256: Hash.bind(null, 'sha256') })
  let cached: { value: string | undefined; at: number } | null = null
  let inflight: Promise<string | undefined> | null = null
  async function fetchSecret(): Promise<string | undefined> {
    const body = JSON.stringify({ SecretId: o.secretArn })
    const signed = await signer.sign({
      method: 'POST', protocol: endpoint.protocol, hostname: endpoint.hostname, ...(endpoint.port ? { port: Number(endpoint.port) } : {}), path: endpoint.pathname,
      headers: { host: endpoint.host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' }, body,
    })
    const headers: Record<string, string> = { ...(signed.headers as Record<string, string>) }
    delete headers.host
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
    const text = await r.text()
    if (r.status !== 200) throw new Error(`GetSecretValue HTTP ${r.status}: ${text.slice(0, 200)}`)
    const v = (JSON.parse(text) as { SecretString?: string }).SecretString?.trim()
    return v && v !== UNCONFIGURED ? v : undefined
  }
  return {
    async get() {
      if (cached && Date.now() - cached.at < o.cacheMs) return cached.value
      inflight ??= fetchSecret().then((value) => { cached = { value, at: Date.now() }; return value }).finally(() => { inflight = null })
      return inflight
    },
    invalidate() { cached = null },
  }
}

export interface DeepSeekProxyOptions {
  upstream: string
  keys: KeySource
  onCall?: (s: DeepSeekCallSummary) => void
}

export async function startDeepSeekProxy(opts: DeepSeekProxyOptions): Promise<{ server: http.Server; base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => { void handle(Buffer.concat(chunks)) })
    async function handle(body: Buffer): Promise<void> {
      const url = req.url ?? '/'
      const path = url.split('?')[0] as string
      const s: DeepSeekCallSummary = { at: Date.now(), method: req.method ?? 'GET', path, bytesIn: body.length, status: null, ms: 0, cancelled: false, keyConfigured: false }
      const json = (status: number, message: string, type: string) => {
        s.status = status
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type, message } }))
      }
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) { s.cancelled = true; ac.abort() } })
      try {
        const method = req.method ?? 'GET'
        if (!isAllowedDeepSeekCall(method, path)) { json(404, `${method} ${path} is not proxied`, 'not_found_error'); return }
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && typeof v === 'string') headers[k] = v
        const send = async (): Promise<Response | undefined> => {
          const key = await opts.keys.get()
          s.keyConfigured = Boolean(key)
          if (!key) return undefined
          return fetch(`${opts.upstream}${url}`, { method, headers: { ...headers, 'x-api-key': key, authorization: `Bearer ${key}` }, ...(body.length ? { body } : {}), redirect: 'error', signal: ac.signal })
        }
        let r = await send()
        // key 可能已在 Secrets Manager 中轮换：作废缓存重读一次
        if (r?.status === 401) { await r.body?.cancel(); opts.keys.invalidate(); r = await send() }
        if (!r) { json(401, 'DeepSeek API key is not configured for this deployment', 'authentication_error'); return }
        s.status = r.status
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !DROP.has(k))))
        if (r.status !== 200) {
          const t = await r.text()
          s.errorBody = t.slice(0, 300)
          res.end(t)
          return
        }
        if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
        res.end()
      } catch (e) {
        s.error = `${(e as Error).name}: ${(e as Error).message}`
        if (!res.headersSent) json(502, 'deepseek proxy upstream error', 'api_error')
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

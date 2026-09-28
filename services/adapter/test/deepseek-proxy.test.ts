import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { secretKeySource, startDeepSeekProxy, staticKeySource, UNCONFIGURED, type DeepSeekCallSummary, type KeySource } from '../src/deepseek-proxy.js'

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const close = (s: http.Server) => new Promise<void>((r) => s.close(() => r()))
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('DeepSeek 网页搜索代理', () => {
  let up: { server: http.Server; base: string }
  const seen: { path: string; key: string; auth: string; body: string }[] = []
  let validKey = 'sk-real-1'
  beforeAll(async () => {
    up = await listen((req, res) => {
      let body = ''
      req.on('data', (d: Buffer) => { body += d.toString() })
      req.on('end', () => {
        seen.push({ path: req.url ?? '', key: String(req.headers['x-api-key'] ?? ''), auth: String(req.headers.authorization ?? ''), body })
        if (req.headers['x-api-key'] !== validKey) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid api key"}}'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"content":[{"type":"text","text":"result"}]}')
      })
    })
  })
  afterAll(() => close(up.server))

  it('替换占位 key 后转发 POST /anthropic/v1/messages，并回调调用摘要（不含 key）', async () => {
    const calls: DeepSeekCallSummary[] = []
    const p = await startDeepSeekProxy({ upstream: up.base, keys: staticKeySource('sk-real-1'), onCall: (s) => calls.push(s) })
    const r = await fetch(`${p.base}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'placeholder', authorization: 'Bearer placeholder', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: '{"q":1}' })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('result')
    expect(seen.at(-1)).toMatchObject({ path: '/anthropic/v1/messages', key: 'sk-real-1', auth: 'Bearer sk-real-1', body: '{"q":1}' })
    await settle()
    expect(calls.at(-1)).toMatchObject({ status: 200, keyConfigured: true })
    expect(JSON.stringify(calls)).not.toContain('sk-real-1')
    await p.close()
  })

  it('对话模型与 Files API 的端点同样注入 key 转发（含查询串与 DELETE）', async () => {
    const p = await startDeepSeekProxy({ upstream: up.base, keys: staticKeySource('sk-real-1') })
    expect((await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer placeholder' }, body: '{"model":"deepseek-flash"}' })).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ path: '/chat/completions', auth: 'Bearer sk-real-1', body: '{"model":"deepseek-flash"}' })
    expect((await fetch(`${p.base}/files?purpose=vision&limit=5`)).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ path: '/files?purpose=vision&limit=5', key: 'sk-real-1' })
    expect((await fetch(`${p.base}/files/file-abc`, { method: 'DELETE' })).status).toBe(200)
    expect(seen.at(-1)?.path).toBe('/files/file-abc')
    await p.close()
  })

  it('其他路径与方法一律 404，不转发', async () => {
    const p = await startDeepSeekProxy({ upstream: up.base, keys: staticKeySource('sk-real-1') })
    const n = seen.length
    for (const [method, path] of [['POST', '/v1/chat/completions'], ['GET', '/anthropic/v1/messages'], ['GET', '/user/balance'], ['PUT', '/files/x'], ['POST', '/files/x/content']]) {
      expect((await fetch(`${p.base}${path}`, { method, ...(method === 'GET' ? {} : { body: '{}' }) })).status, `${method} ${path}`).toBe(404)
    }
    expect(seen.length).toBe(n)
    await p.close()
  })

  it('未配置 key（空或占位值）→ 401 authentication_error，不转发', async () => {
    for (const k of [undefined, '', UNCONFIGURED]) {
      const p = await startDeepSeekProxy({ upstream: up.base, keys: staticKeySource(k) })
      const n = seen.length
      const r = await fetch(`${p.base}/anthropic/v1/messages`, { method: 'POST', body: '{}' })
      expect(r.status).toBe(401)
      expect(await r.text()).toContain('not configured')
      expect(seen.length).toBe(n)
      await p.close()
    }
  })

  it('上游 401（key 已轮换）时作废缓存、重新取 key 再试一次', async () => {
    let current = 'sk-old'
    let invalidated = 0
    const keys: KeySource = { get: async () => current, invalidate: () => { invalidated++; current = 'sk-new' } }
    validKey = 'sk-new'
    const p = await startDeepSeekProxy({ upstream: up.base, keys })
    const r = await fetch(`${p.base}/anthropic/v1/messages`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    expect(invalidated).toBe(1)
    validKey = 'sk-real-1'
    await p.close()
  })
})

describe('secretKeySource：SigV4 调用 Secrets Manager GetSecretValue 并缓存', () => {
  it('读取、缓存、作废后重读；占位值视为未配置', async () => {
    const reqs: { target: string; auth: string; body: string }[] = []
    let value = 'sk-from-secret'
    const sm = await listen((req, res) => {
      let body = ''
      req.on('data', (d: Buffer) => { body += d.toString() })
      req.on('end', () => {
        reqs.push({ target: String(req.headers['x-amz-target']), auth: String(req.headers.authorization), body })
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
        res.end(JSON.stringify({ SecretString: value }))
      })
    })
    const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:DeepSeekApiKey-abc'
    const src = secretKeySource({ secretArn: arn, credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 's' }, cacheMs: 60_000, endpoint: `${sm.base}/` })
    expect(await src.get()).toBe('sk-from-secret')
    expect(await src.get()).toBe('sk-from-secret')
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({ target: 'secretsmanager.GetSecretValue', body: JSON.stringify({ SecretId: arn }) })
    expect(reqs[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/secretsmanager\/aws4_request/)
    value = UNCONFIGURED
    src.invalidate()
    expect(await src.get()).toBeUndefined()
    expect(reqs).toHaveLength(2)
    await close(sm.server)
  })
})

describe('新会话的默认模型', () => {
  it('配置了 DeepSeek key → deepseek-official/deepseek-flash；未配置或 DEFAULT_MODEL=bedrock → Bedrock', async () => {
    const { defaultModel } = await import('../src/dsh-process.js')
    const model = { id: 'deepseek.v3.2' } as never
    expect(defaultModel({ defaultModel: 'auto', model }, true)).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(defaultModel({ defaultModel: 'auto', model }, false)).toEqual({ provider: 'bedrock', model: 'deepseek.v3.2' })
    expect(defaultModel({ defaultModel: 'bedrock', model }, true)).toEqual({ provider: 'bedrock', model: 'deepseek.v3.2' })
  })
})

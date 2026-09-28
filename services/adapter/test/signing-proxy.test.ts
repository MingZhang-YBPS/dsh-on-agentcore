import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { startSigningProxy, upstreamUrl, type ModelCallSummary } from '../src/signing-proxy.js'
import { loadConfig } from '../src/config.js'

describe('upstreamUrl', () => {
  it('把 /openai/v1 映射到端点面的 base 路径；无路径的 base 原样拼接', () => {
    expect(upstreamUrl('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', '/openai/v1/chat/completions').href).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions')
    expect(upstreamUrl('https://bedrock-mantle.us-east-1.api.aws/v1', '/openai/v1/chat/completions').href).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions')
    expect(upstreamUrl('http://127.0.0.1:9', '/openai/v1/chat/completions').href).toBe('http://127.0.0.1:9/openai/v1/chat/completions')
  })
})

describe('签名代理', () => {
  let up: http.Server
  let upBase: string
  const seen: { auth: string; sha: string | undefined; path: string }[] = []
  beforeAll(async () => {
    up = http.createServer((req, res) => {
      seen.push({ auth: String(req.headers.authorization ?? ''), sha: req.headers['x-amz-content-sha256'] as string | undefined, path: req.url ?? '' })
      req.resume()
      req.on('end', () => {
        if (req.url?.includes('deny')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"not authorized to perform: bedrock:InvokeModel"}}'); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '执行命令。\n\n<｜DSML｜function_calls' }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    upBase = `http://127.0.0.1:${(up.address() as { port: number }).port}/v1`
  })
  afterAll(() => new Promise<void>((r) => up.close(() => r())))

  it('用 SigV4 重新签名、映射路径、剥离原始标记，并回调调用摘要', async () => {
    const calls: ModelCallSummary[] = []
    const p = await startSigningProxy({ upstreamBase: upBase, region: 'us-east-1', service: 'bedrock-mantle', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' }, onCall: (s) => calls.push(s) })
    const r = await fetch(`${p.base}/openai/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer placeholder', 'content-type': 'application/json' }, body: '{"model":"m"}' })
    const text = await r.text()
    expect(text).not.toContain('DSML')
    expect(text).toContain('执行命令。')
    expect(text).toContain('tool_calls')
    const last = seen.at(-1)
    expect(last?.path).toBe('/v1/chat/completions')
    expect(last?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/)
    expect(last?.sha).toMatch(/^[0-9a-f]{64}$/)
    await new Promise((res) => setTimeout(res, 50))
    expect(calls.at(-1)).toMatchObject({ status: 200, strippedRawToolMarkup: 1, cancelled: false })
    await p.close()
  })

  it('非 200 响应原样转发并记录 errorBody', async () => {
    const calls: ModelCallSummary[] = []
    const p = await startSigningProxy({ upstreamBase: upBase, region: 'us-east-1', credentials: { accessKeyId: 'A', secretAccessKey: 'B' }, onCall: (s) => calls.push(s) })
    const r = await fetch(`${p.base}/openai/v1/deny`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
    expect(await r.text()).toContain('not authorized')
    await new Promise((res) => setTimeout(res, 50))
    expect(calls.at(-1)?.errorBody).toContain('bedrock:InvokeModel')
    await p.close()
  })
})

describe('loadConfig', () => {
  it('默认值与校验', () => {
    const c = loadConfig({ MODEL_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1' })
    expect(c).toMatchObject({ port: 8080, dshPort: 3080, userHome: '/mnt/workspace', mirror: true, requireSessionOwner: true, wsKeepaliveMs: 20000, wsFrameMax: 49152 })
    expect(c.patches.map((p) => p.split('/').slice(-2).join('/'))).toEqual(['dsh/web.cordis.yml', 'dsh/web-hardening.cordis.yml'])
    expect(() => loadConfig({})).toThrow(/MODEL_BASE_URL/)
    expect(() => loadConfig({ MOCK_MODEL: '1', WS_FRAME_MAX: String(64 * 1024) })).toThrow(/64 KB/)
    expect(loadConfig({ MOCK_MODEL: '1', REQUIRE_SESSION_OWNER: '0' }).requireSessionOwner).toBe(false)
    expect(c.defaultModel).toBe('auto')
    expect(loadConfig({ MOCK_MODEL: '1', DEFAULT_MODEL: 'bedrock' }).defaultModel).toBe('bedrock')
  })
})

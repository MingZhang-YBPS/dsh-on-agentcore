// 两个本地代理：
// 1. 签名代理：适配层内的 127.0.0.1 监听，DSH 的 baseURL 指向它。去掉 DSH 发来的占位 Authorization，
//    用 SigV4（service=bedrock）重新签名后转发到上游，并把 SSE 响应原样流回；DSH 断开时中止上游请求。
// 2. 外联记录代理：作为 HTTP(S)_PROXY 注入 DSH 进程，记录任何非回环地址的外联尝试并一律拒绝。

import http from 'node:http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'authorization'])

export async function startSigningProxy({ upstreamBase, region, service = 'bedrock', credentials }) {
  const signer = new SignatureV4({ service, region, credentials, sha256: Hash.bind(null, 'sha256') })
  const upstream = new URL(upstreamBase)
  const log = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const entry = {
        at: Date.now(),
        method: req.method,
        path: req.url,
        inboundHeaders: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, /authorization/i.test(k) ? `${String(v).split(' ')[0]} <redacted>` : v])),
        bodyBytes: body.length,
        downstreamClosedEarly: false,
        upstreamAborted: false,
      }
      log.push(entry)
      const ac = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) { entry.downstreamClosedEarly = true; entry.upstreamAborted = true; ac.abort() }
      })
      try {
        const u = new URL(req.url, upstream)
        const headers = { host: u.host }
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v
        const signed = await signer.sign({
          method: req.method, protocol: u.protocol, hostname: u.hostname, port: u.port ? Number(u.port) : undefined,
          path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...headers, 'x-amz-content-sha256': signerHash(body) }, body,
        })
        const out = { ...signed.headers }
        delete out.host
        const r = await fetch(u, { method: req.method, headers: out, body: body.length ? body : undefined, signal: ac.signal })
        entry.upstreamStatus = r.status
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !HOP.has(k))))
        if (r.body) for await (const chunk of r.body) res.write(chunk)
        res.end()
      } catch (e) {
        entry.error = `${e.name}: ${e.message}`
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'signing proxy upstream error' } })) } else res.destroy()
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, log, base: `http://127.0.0.1:${server.address().port}` }
}

import { createHash } from 'node:crypto'
function signerHash(body) { return createHash('sha256').update(body).digest('hex') }

export async function startEgressRecorder() {
  const attempts = []
  const server = http.createServer((req, res) => {
    attempts.push({ at: Date.now(), kind: 'http', method: req.method, target: req.url })
    res.writeHead(403); res.end('egress blocked by spike05 recorder')
  })
  server.on('connect', (req, socket) => {
    attempts.push({ at: Date.now(), kind: 'connect', target: req.url })
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, attempts, url: `http://127.0.0.1:${server.address().port}` }
}

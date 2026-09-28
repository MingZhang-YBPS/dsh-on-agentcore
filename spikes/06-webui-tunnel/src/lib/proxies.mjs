// 两个本地代理：
// 1. 签名代理：适配层内的 127.0.0.1 监听，DSH 的 baseURL 指向它。去掉 DSH 发来的占位 Authorization，
//    用 SigV4（service=bedrock）重新签名后转发到上游，并把 SSE 响应原样流回；DSH 断开时中止上游请求。
// 2. 外联记录代理：作为 HTTP(S)_PROXY 注入 DSH 进程，记录任何非回环地址的外联尝试并一律拒绝。

import http from 'node:http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'authorization'])

export async function startSigningProxy({ upstreamBase, region, service = 'bedrock', credentials, stripRawToolMarkup = true, onEntry }) {
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
        // upstreamBase 带路径时（例如 https://bedrock-mantle.<region>.api.aws/v1），把 DSH 请求路径中的本地前缀
        // /openai/v1 换成该路径；不带路径时（模拟上游）原样拼接（Spike 07）
        const basePath = upstream.pathname.replace(/\/$/, '')
        const target = basePath && req.url.startsWith('/openai/v1') ? basePath + req.url.slice('/openai/v1'.length) : req.url
        const u = new URL(target, upstream)
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
        const isSse = (r.headers.get('content-type') ?? '').includes('text/event-stream')
        const filter = stripRawToolMarkup && isSse && r.status === 200 ? createRawToolMarkupFilter() : null
        if (r.status !== 200) {
          // 错误响应体很小：整体读出后原样转发，并留一段在日志里（便于区分 IAM 拒绝、模型不存在、参数错误）
          const t = await r.text()
          entry.errorBody = t.slice(0, 300)
          res.write(t)
        } else if (r.body) for await (const chunk of r.body) res.write(filter ? filter.push(chunk) : chunk)
        if (filter) { res.write(filter.end()); entry.strippedRawToolMarkup = filter.stats.stripped }
        res.end()
        entry.ms = Date.now() - entry.at
        onEntry?.(entry)
      } catch (e) {
        entry.error = `${e.name}: ${e.message}`
        entry.ms = Date.now() - entry.at
        onEntry?.(entry)
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'signing proxy upstream error' } })) } else res.destroy()
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, log, base: `http://127.0.0.1:${server.address().port}` }
}

import { createHash } from 'node:crypto'
function signerHash(body) { return createHash('sha256').update(body).digest('hex') }

// Bedrock 上的 deepseek.v3.2（bedrock-runtime 与 bedrock-mantle 两个端点面）在返回结构化 tool_calls 的同时，
// 会把模型原始的工具调用标记开头（`<｜DSML｜function_calls`）漏进 delta.content（Spike 07 实测 12/12 次）。
// DSH 会把它当正文展示并写进会话历史。这里逐帧改写 SSE：某个 choice 的正文一旦出现标记，就丢弃标记及其后的正文；
// 片段末尾可能是标记的前缀时先扣住，下一片段或 finish_reason 到达时再决定放行还是丢弃。其余字段与帧原样保留。
const RAW_MARKS = ['<｜DSML｜', '<｜tool▁calls▁begin｜>', '<｜tool▁call▁begin｜>']
export function createRawToolMarkupFilter() {
  const dec = new TextDecoder()
  let buf = ''
  const choices = new Map() // index → { dropping, held }
  const stats = { stripped: 0, frames: 0 }
  function filterContent(st, content) {
    let s = st.held + content
    st.held = ''
    if (st.dropping) return ''
    let cut = -1
    for (const m of RAW_MARKS) { const i = s.indexOf(m); if (i >= 0 && (cut < 0 || i < cut)) cut = i }
    if (cut >= 0) { st.dropping = true; stats.stripped++; return s.slice(0, cut).replace(/\s+$/, '') }
    for (let k = Math.min(s.length, Math.max(...RAW_MARKS.map((m) => m.length)) - 1); k > 0; k--) {
      const tail = s.slice(-k)
      if (RAW_MARKS.some((m) => m.startsWith(tail))) { st.held = tail; return s.slice(0, -k) }
    }
    return s
  }
  function rewriteFrame(frame) {
    stats.frames++
    const lines = frame.split('\n')
    const i = lines.findIndex((l) => l.startsWith('data:'))
    if (i < 0) return frame
    const payload = lines[i].slice(5).trim()
    if (payload === '[DONE]') return frame
    let obj
    try { obj = JSON.parse(payload) } catch { return frame }
    for (const c of obj.choices ?? []) {
      const st = choices.get(c.index ?? 0) ?? { dropping: false, held: '' }
      choices.set(c.index ?? 0, st)
      if (typeof c.delta?.content === 'string') c.delta.content = filterContent(st, c.delta.content)
      if (c.finish_reason && st.held) { c.delta = { ...(c.delta ?? {}), content: (c.delta?.content ?? '') + st.held }; st.held = '' }
    }
    lines[i] = `data: ${JSON.stringify(obj)}`
    return lines.join('\n')
  }
  return {
    stats,
    push(chunk) {
      buf += dec.decode(chunk, { stream: true })
      let out = ''
      let j
      while ((j = buf.indexOf('\n\n')) >= 0) { out += rewriteFrame(buf.slice(0, j)) + '\n\n'; buf = buf.slice(j + 2) }
      return out
    },
    end() { const rest = buf + dec.decode(); buf = ''; return rest },
  }
}

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

// HTTP-over-/invocations 隧道的封包格式（网关与容器内适配器共用）。
//
// 请求（网关 → POST /invocations 的请求体，JSON）：
//   { v: 1, method, path /* 含查询串 */, headers: {name: value|[values]}, body: base64 | null }
// 响应（适配器 → /invocations 的响应体，二进制流）：
//   第一行是 JSON 元数据 { v: 1, status, headers }，以 '\n' 结尾；其后原样是 DSH 的响应体字节（可流式）。
// 这样 AgentCore 只需要把 /invocations 的请求体和响应体原样传递，不依赖它转发任何自定义头或状态码。

export const ENVELOPE_VERSION = 1

// 逐跳头与由各跳自行计算的头：隧道两端都不转发
export const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'content-length', 'host',
])

export function encodeRequest({ method, path, headers, body }) {
  return Buffer.from(JSON.stringify({
    v: ENVELOPE_VERSION, method, path, headers,
    body: body && body.length ? Buffer.from(body).toString('base64') : null,
  }))
}

export function decodeRequest(buf) {
  const r = JSON.parse(Buffer.from(buf).toString('utf8'))
  if (r.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${r.v}`)
  return { ...r, body: r.body ? Buffer.from(r.body, 'base64') : Buffer.alloc(0) }
}

export function encodeResponseHead({ status, headers }) {
  return Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, status, headers }) + '\n')
}

// 从异步字节流里拆出第一行元数据，返回 { head, rest: AsyncIterable<Buffer> }
export async function decodeResponseStream(iterable) {
  const it = iterable[Symbol.asyncIterator]()
  let buf = Buffer.alloc(0)
  for (;;) {
    const { value, done } = await it.next()
    if (done) throw new Error('tunnel response ended before header line')
    buf = Buffer.concat([buf, Buffer.from(value)])
    const nl = buf.indexOf(0x0a)
    if (nl >= 0) {
      const head = JSON.parse(buf.subarray(0, nl).toString('utf8'))
      const first = buf.subarray(nl + 1)
      const rest = (async function* () {
        if (first.length) yield first
        for (;;) {
          const n = await it.next()
          if (n.done) return
          yield Buffer.from(n.value)
        }
      })()
      return { head, rest }
    }
    if (buf.length > 1024 * 1024) throw new Error('tunnel header line too long')
  }
}

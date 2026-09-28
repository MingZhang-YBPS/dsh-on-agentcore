// HTTP-over-/invocations 隧道的封包格式（隧道 Lambda 与 microVM 内适配器共用），以及 WebSocket 消息分片。
//
// 请求（隧道 → POST /invocations 的请求体，JSON）：
//   { v: 1, method, path /* 含原始查询串 */, headers: {name: value | values[]}, body: base64 | null }
// 响应（适配器 → /invocations 的响应体，二进制流）：
//   第一行是 JSON 元数据 { v: 1, status, headers }，以 '\n' 结尾；其后原样是 DSH 的响应体字节（可流式）。
// AgentCore 只需要原样传递 /invocations 的请求体和响应体，不依赖它转发任何自定义头或状态码。

export const ENVELOPE_VERSION = 1

export type HeaderValue = string | string[]
export type Headers = Record<string, HeaderValue>

export interface TunnelRequest {
  method: string
  path: string
  headers: Headers
  body: Uint8Array
}

export interface ResponseHead {
  status: number
  headers: Headers
}

/** 逐跳头与由各跳自行计算的头：隧道两端都不转发 */
export const HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'host',
])

/** 封包响应第一行的长度上限：超过即视为协议错误，避免无界缓冲 */
export const MAX_HEAD_BYTES = 1024 * 1024

export function encodeRequest(req: TunnelRequest): Buffer {
  return Buffer.from(JSON.stringify({
    v: ENVELOPE_VERSION,
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body.length ? Buffer.from(req.body).toString('base64') : null,
  }))
}

export function decodeRequest(buf: Uint8Array): TunnelRequest {
  const r = JSON.parse(Buffer.from(buf).toString('utf8')) as Record<string, unknown>
  if (r.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${String(r.v)}`)
  if (typeof r.method !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error('malformed envelope')
  if (r.headers === null || typeof r.headers !== 'object' || Array.isArray(r.headers)) throw new Error('malformed envelope headers')
  if (r.body !== null && typeof r.body !== 'string') throw new Error('malformed envelope body')
  return { method: r.method, path: r.path, headers: r.headers as Headers, body: r.body ? Buffer.from(r.body, 'base64') : Buffer.alloc(0) }
}

export function encodeResponseHead(head: ResponseHead): Buffer {
  return Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, status: head.status, headers: head.headers }) + '\n')
}

/** 从异步字节流里拆出第一行元数据，返回元数据与其余字节的异步迭代器（任意切块都能正确拆分） */
export async function decodeResponseStream(iterable: AsyncIterable<Uint8Array>): Promise<{ head: ResponseHead; rest: AsyncGenerator<Buffer> }> {
  const it = iterable[Symbol.asyncIterator]()
  let buf = Buffer.alloc(0)
  for (;;) {
    const { value, done } = await it.next()
    if (done) throw new Error('tunnel response ended before header line')
    buf = Buffer.concat([buf, Buffer.from(value)])
    const nl = buf.indexOf(0x0a)
    if (nl >= 0) {
      const parsed = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { v?: unknown; status?: unknown; headers?: unknown }
      if (parsed.v !== ENVELOPE_VERSION || typeof parsed.status !== 'number') throw new Error('malformed tunnel response head')
      const head: ResponseHead = { status: parsed.status, headers: (parsed.headers ?? {}) as Headers }
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
    if (buf.length > MAX_HEAD_BYTES) throw new Error('tunnel header line too long')
  }
}

// ---------------- WebSocket 消息分片 ----------------
// AgentCore /ws 对单个帧有 64 KB 上限（超限以 1009 关闭连接，Spike 09）。发往 AgentCore 一侧的大消息拆成
// RFC 6455 续帧：除最后一帧外 fin=false。限制作用于帧而不是消息，所以分片后的大消息可以通过。

export interface Fragment {
  data: Buffer
  fin: boolean
}

/** 把消息按不超过 max 字节拆成若干帧；空消息与不超过 max 的消息只产生一个帧 */
export function fragment(message: Uint8Array, max: number): Fragment[] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`fragment max must be a positive integer, got ${max}`)
  const buf = Buffer.from(message.buffer, message.byteOffset, message.byteLength)
  if (buf.length <= max) return [{ data: buf, fin: true }]
  const out: Fragment[] = []
  for (let off = 0; off < buf.length; off += max) out.push({ data: buf.subarray(off, off + max), fin: off + max >= buf.length })
  return out
}

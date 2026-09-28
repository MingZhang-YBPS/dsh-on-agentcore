// 共享的 fast-check 生成器
import fc from 'fast-check'

export const RUNS = { default: 100, roundTrip: 300 } as const

/** 任意字节（含 0 字节、非 UTF-8 序列），长度 0..maxLength */
export const arbBytes = (maxLength = 4096) => fc.uint8Array({ maxLength }).map((u) => Buffer.from(u))

/** HTTP 方法 */
export const arbMethod = fc.constantFrom('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')

/** 路径 + 原始查询串，包括 DSH 插件包的 `??a,b&rev=` 形态与多语言、百分号编码字符 */
export const arbPath = fc.oneof(
  fc.webPath().map((p) => (p.startsWith('/') ? p : `/${p}`)),
  fc.tuple(fc.array(fc.stringMatching(/^@[a-z-]{1,12}\/[a-z-]{1,12}\/client\.js$/), { minLength: 1, maxLength: 5 }), fc.stringMatching(/^[0-9a-f]{4,12}$/))
    .map(([mods, rev]) => `/plugins/??${mods.join(',')}&rev=${rev}`),
  fc.tuple(fc.webPath(), fc.webQueryParameters()).map(([p, q]) => `${p.startsWith('/') ? p : `/${p}`}?${q}`),
  fc.string({ unit: 'grapheme', maxLength: 20 }).map((s) => `/api/${encodeURIComponent(s)}`),
)

const headerName = fc.stringMatching(/^[a-z][a-z0-9-]{0,24}$/)
const headerValue = fc.string({ unit: 'grapheme-ascii', maxLength: 60 })
export const arbHeaders = fc.dictionary(headerName, fc.oneof(headerValue, fc.array(headerValue, { minLength: 1, maxLength: 3 })), { maxKeys: 12 })

/** 把缓冲区随机切成若干块（可含空块） */
export const arbChunking = (buf: Buffer) =>
  fc.array(fc.integer({ min: 0, max: Math.max(buf.length, 1) }), { maxLength: 12 }).map((cuts) => {
    const pts = [...new Set([0, ...cuts.map((c) => Math.min(c, buf.length)), buf.length])].sort((a, b) => a - b)
    const out: Buffer[] = []
    for (let i = 1; i < pts.length; i++) out.push(buf.subarray(pts[i - 1], pts[i]))
    return out.length ? out : [buf]
  })

export async function* toAsync(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const c of chunks) yield c
}

export const arbUuid = fc.uuid({ version: 4 })

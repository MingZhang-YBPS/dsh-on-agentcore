// 用户 ↔ AgentCore 运行时会话的映射、容器内的会话归属校验，以及隧道两端的请求头过滤（纯函数）。

import { HOP_HEADERS, type Headers, type HeaderValue } from '@dsh-poc/envelope'

export const SESSION_PREFIX = 'dsh-user-'
/** AgentCore 要求 runtimeSessionId 至少 33 个字符 */
export const MIN_SESSION_ID_LENGTH = 33
const SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Cognito sub（UUID）→ runtimeSessionId；sub 形态不对时抛错（会话 ID 只能由已验签令牌的主体派生） */
export function sessionIdOf(sub: string): string {
  if (!SUB_RE.test(sub)) throw new Error('token subject is not a UUID')
  return `${SESSION_PREFIX}${sub}`
}

/** 只解码、不验签：签名由 AgentCore 的 JWT 授权器验证，未验签的令牌到不了容器 */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null
  try {
    const v = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const first = (v: HeaderValue | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/**
 * 会话归属校验：返回拒绝原因，放行时返回 null。
 * headers 为 Node 已小写化的请求头；AgentCore 在 /ws 上只转发写成 `Authorization` 的头（Spike 06 C15），
 * 到达容器时 Node 同样将其小写。
 */
export function sessionOwnerRejection(headers: Record<string, HeaderValue | undefined>): string | null {
  const sid = first(headers['x-amzn-bedrock-agentcore-runtime-session-id'])
  const auth = first(headers.authorization) ?? ''
  const m = /^Bearer (\S+)$/.exec(auth)
  if (!m) return 'missing bearer token'
  const p = jwtPayload(m[1] as string)
  if (!p) return 'malformed token'
  const sub = p.sub
  if (typeof sub !== 'string' || !SUB_RE.test(sub)) return 'token has no valid subject'
  if (sid !== `${SESSION_PREFIX}${sub}`) return 'session does not belong to token subject'
  return null
}

/** 浏览器请求头 → 发往 DSH 的请求头：去掉逐跳头与身份相关头，换上适配器持有的 DSH cookie，Host 改为 DSH 地址 */
export function toDshHeaders(inHeaders: Headers, dshAuthority: string, dshCookie: string | null): Headers {
  const out: Headers = {}
  for (const [k0, v] of Object.entries(inHeaders)) {
    const k = k0.toLowerCase()
    if (HOP_HEADERS.has(k) || k === 'origin' || k === 'cookie' || k === 'authorization') continue
    if (k.startsWith('sec-fetch-') || k.startsWith('x-amz')) continue
    out[k] = v
  }
  out.host = dshAuthority
  if (dshCookie) out.cookie = dshCookie
  return out
}

/** DSH 响应头 → 返回浏览器的响应头：去掉逐跳头与 DSH 自己的鉴权 cookie（dsh-auth-*），其余原样 */
export function fromDshHeaders(inHeaders: Record<string, HeaderValue | undefined>): Headers {
  const out: Headers = {}
  for (const [k0, v] of Object.entries(inHeaders)) {
    if (v === undefined) continue
    const k = k0.toLowerCase()
    if (HOP_HEADERS.has(k)) continue
    if (k === 'set-cookie') {
      const kept = (Array.isArray(v) ? v : [v]).filter((c) => !c.trimStart().startsWith('dsh-auth-'))
      if (kept.length) out[k] = kept
      continue
    }
    out[k] = v
  }
  return out
}

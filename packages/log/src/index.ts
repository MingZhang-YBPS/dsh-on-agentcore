// 结构化日志（适配器与隧道 Lambda 共用）：每条一行 JSON。
// 敏感字段不写入日志：键名匹配 SENSITIVE_KEY 的字段整体丢弃；字符串值中形如 JWT、Bearer 令牌、
// cookie 值、SigV4 签名的片段替换为 <redacted>（Property 8）。

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Fields = Record<string, unknown>
export type Logger = (level: Level, msg: string, fields?: Fields) => void

export const SENSITIVE_KEY = /token|password|passwd|secret|authorization|cookie|credential|signature|session[-_]?token/i
const VALUE_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bBearer\s+\S+/gi,
  /\b(dsh_token|dsh_refresh|dsh-auth-[A-Za-z0-9_-]+)=[^;\s]*/g, // cookie 值
  /\bSignature=[0-9a-f]{16,}/gi,
  /([?&](token|X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential)=)[^&\s]*/gi,
]

export function redactString(s: string): string {
  let out = s
  for (const re of VALUE_PATTERNS) out = out.replace(re, (m, p1: unknown) => (typeof p1 === 'string' && m.startsWith(p1) && /[?&]/.test(p1) ? `${p1}<redacted>` : '<redacted>'))
  return out
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<truncated>'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEY.test(k)) out[k] = redact(v, depth + 1)
    return out
  }
  return value
}

export interface LoggerOptions { write?: (line: string) => void; minLevel?: Level; base?: Fields }

export function createLogger({ write = (line: string) => { process.stdout.write(line + '\n') }, minLevel = 'debug', base = {} }: LoggerOptions = {}): Logger {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  return (level, msg, fields = {}) => {
    if (order[level] < order[minLevel]) return
    write(JSON.stringify({ t: new Date().toISOString(), level, msg: redactString(msg), ...(redact({ ...base, ...fields }) as Fields) }))
  }
}

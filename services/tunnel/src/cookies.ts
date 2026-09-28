// cookie 解析与下发。访问令牌与刷新令牌都放在 HttpOnly + Secure 的 cookie 里，脚本不可读。

export const ACCESS_COOKIE = 'dsh_token'
export const REFRESH_COOKIE = 'dsh_refresh'

/** Lambda Function URL 事件里的 cookies 数组 → Map（同名取第一个） */
export function parseCookies(list: readonly string[] | undefined, header?: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = [...(list ?? []), ...(header ? header.split(';') : [])]
  for (const c of parts) {
    const i = c.indexOf('=')
    if (i <= 0) continue
    const k = c.slice(0, i).trim()
    if (!out.has(k)) out.set(k, c.slice(i + 1).trim())
  }
  return out
}

export function accessCookie(token: string, maxAgeSeconds: number): string {
  return `${ACCESS_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`
}

export function refreshCookie(token: string, maxAgeSeconds: number): string {
  return `${REFRESH_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Strict`
}

export const CLEAR_COOKIES: readonly string[] = [
  `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  `${REFRESH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
]

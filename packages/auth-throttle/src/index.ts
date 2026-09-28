// 登录输入校验、失败节流判定与统一失败响应（纯函数，隧道 Lambda 使用）。

export const MAX_USERNAME_CODE_POINTS = 64
export const MAX_PASSWORD_CODE_POINTS = 128

export interface ThrottlePolicy {
  /** 窗口内失败达到该次数即锁定 */
  threshold: number
  windowMs: number
  lockMs: number
}
export const DEFAULT_POLICY: ThrottlePolicy = { threshold: 5, windowMs: 5 * 60_000, lockMs: 15 * 60_000 }

const codePoints = (s: string): number => [...s].length

/** 输入合法时返回 true；不合法（为空或超长）时不做凭证比对，直接统一失败 */
export function validateLoginInput(username: string, password: string): boolean {
  if (username.length === 0 || password.length === 0) return false
  return codePoints(username) <= MAX_USERNAME_CODE_POINTS && codePoints(password) <= MAX_PASSWORD_CODE_POINTS
}

/** 规范化用户名作为节流键（Cognito 用户池设置为用户名大小写不敏感） */
export const throttleKey = (username: string): string => username.normalize('NFC').toLowerCase()

export interface ThrottleState {
  /** 计入窗口的失败时间戳（毫秒，升序） */
  failures: number[]
  lockedUntil: number | null
}
export const EMPTY_STATE: ThrottleState = { failures: [], lockedUntil: null }

export function isLocked(state: ThrottleState, now: number): boolean {
  return state.lockedUntil !== null && now < state.lockedUntil
}

/**
 * 记录一次失败并返回新状态：锁定期内的尝试不计入；失败后若最近 windowMs 内（含本次）失败达到 threshold，
 * 从本次失败起锁定 lockMs。只保留窗口内的失败，最多 threshold 个。
 */
export function recordFailure(state: ThrottleState, now: number, policy: ThrottlePolicy = DEFAULT_POLICY): ThrottleState {
  if (isLocked(state, now)) return state
  const recent = [...state.failures.filter((t) => t > now - policy.windowMs && t <= now), now].slice(-policy.threshold)
  const lock = recent.length >= policy.threshold ? now + policy.lockMs : null
  return { failures: lock ? [] : recent, lockedUntil: lock ?? (state.lockedUntil !== null && state.lockedUntil > now ? state.lockedUntil : null) }
}

/** 从一串尝试时间计算锁定状态（参考实现：用于测试 recordFailure，也用于回放审计） */
export function evaluateThrottle(failureTimes: readonly number[], now: number, policy: ThrottlePolicy = DEFAULT_POLICY): ThrottleState {
  let s: ThrottleState = EMPTY_STATE
  for (const t of [...failureTimes].sort((a, b) => a - b)) if (t <= now) s = recordFailure(s, t, policy)
  return s
}

/** 所有失败情形（输入非法、锁定中、凭证错误、用户不存在）返回完全相同的响应 */
export const UNIFORM_FAILURE_STATUS = 401
export const UNIFORM_FAILURE_MESSAGE = '用户名或口令错误'

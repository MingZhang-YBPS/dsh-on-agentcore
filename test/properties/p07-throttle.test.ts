// Feature: poc, Property 7: 登录节流滑动窗口
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { DEFAULT_POLICY, EMPTY_STATE, isLocked, recordFailure, type ThrottlePolicy } from '@dsh-poc/auth-throttle'
import { RUNS } from '../arbitraries/index.js'

// 独立参考模型：按时间顺序处理尝试；锁定期内的尝试不计入；锁定解除后重新计数
function model(times: number[], now: number, p: ThrottlePolicy): boolean {
  let lockedUntil = -Infinity
  let counted: number[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t > now) break
    if (t < lockedUntil) continue
    counted = counted.filter((x) => x > t - p.windowMs)
    counted.push(t)
    if (counted.length >= p.threshold) { lockedUntil = t + p.lockMs; counted = [] }
  }
  return now < lockedUntil
}

const arbPolicy = fc.oneof(
  fc.constant(DEFAULT_POLICY),
  fc.record({ threshold: fc.integer({ min: 1, max: 6 }), windowMs: fc.integer({ min: 1, max: 1000 }), lockMs: fc.integer({ min: 1, max: 3000 }) }),
)

describe('Property 7: 登录节流滑动窗口', () => {
  it('增量 recordFailure 的锁定判定与参考模型一致', () => {
    fc.assert(fc.property(arbPolicy, fc.array(fc.integer({ min: 0, max: 40 * 60_000 }), { maxLength: 30 }), fc.integer({ min: 0, max: 60 * 60_000 }), (p, raw, now0) => {
      const scale = p === DEFAULT_POLICY ? 1 : 1 / 600 // 小参数策略下压缩时间尺度，保证能触发锁定
      const times = raw.map((t) => Math.floor(t * scale)).sort((a, b) => a - b)
      const now = Math.floor(now0 * scale)
      let s = EMPTY_STATE
      for (const t of times) if (t <= now) s = recordFailure(s, t, p)
      expect(isLocked(s, now)).toBe(model(times, now, p))
    }), { numRuns: RUNS.default * 5 })
  })

  it('默认策略：5 分钟内第 5 次失败起锁定 15 分钟，到期后解除', () => {
    let s = EMPTY_STATE
    for (const t of [0, 60_000, 120_000, 180_000]) s = recordFailure(s, t)
    expect(isLocked(s, 180_001)).toBe(false)
    s = recordFailure(s, 240_000)
    expect(isLocked(s, 240_000)).toBe(true)
    expect(isLocked(s, 240_000 + 15 * 60_000 - 1)).toBe(true)
    expect(isLocked(s, 240_000 + 15 * 60_000)).toBe(false)
  })
})

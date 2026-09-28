// Feature: poc, Property 4: 会话 ID 派生
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MIN_SESSION_ID_LENGTH, sessionIdOf } from '@dsh-poc/session-identity'
import { RUNS, arbUuid } from '../arbitraries/index.js'

describe('Property 4: 会话 ID 派生', () => {
  it('确定性、单射、长度不少于 33、只含 AgentCore 允许的字符', () => {
    fc.assert(fc.property(arbUuid, arbUuid, (a, b) => {
      const ia = sessionIdOf(a)
      expect(sessionIdOf(a)).toBe(ia)
      expect(ia.length).toBeGreaterThanOrEqual(MIN_SESSION_ID_LENGTH)
      expect(ia).toMatch(/^[a-zA-Z0-9-]+$/)
      if (a !== b) expect(sessionIdOf(b)).not.toBe(ia)
    }), { numRuns: RUNS.default })
  })

  it('非 UUID 形态的 sub 被拒绝', () => {
    fc.assert(fc.property(fc.string({ maxLength: 50 }).filter((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)), (s) => {
      expect(() => sessionIdOf(s)).toThrow()
    }), { numRuns: RUNS.default })
  })
})

// 隧道 Lambda 测试用的内存实现
import { EMPTY_STATE, type ThrottleState } from '@dsh-poc/auth-throttle'
import { encodeResponseHead } from '@dsh-poc/envelope'
import type { Deps, FunctionUrlEvent } from '../src/handler.js'
import { AuthFailed, type AuthPort, type OpenResponse, type RuntimePort, type ThrottleStore } from '../src/ports.js'

export const SUB = '11111111-2222-4333-8444-555555555555'
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const makeJwt = (payload: Record<string, unknown>) => `${b64u({ alg: 'RS256' })}.${b64u(payload)}.c2ln`
export const accessToken = (expSec: number, sub = SUB, username = 'alice') => makeJwt({ sub, username, exp: expSec, client_id: 'c' })

export interface Captured { status: number; headers: Record<string, string>; cookies: string[]; body: Buffer; ended: boolean }
export function capture(): { open: OpenResponse; res: Captured } {
  const res: Captured = { status: 0, headers: {}, cookies: [], body: Buffer.alloc(0), ended: false }
  const open: OpenResponse = (status, headers, cookies = []) => {
    if (res.status) throw new Error('opened twice')
    Object.assign(res, { status, headers, cookies: [...cookies] })
    return { write: (c) => { res.body = Buffer.concat([res.body, Buffer.from(c)]) }, end: () => { res.ended = true } }
  }
  return { open, res }
}

export class MemThrottle implements ThrottleStore {
  items = new Map<string, { state: ThrottleState; version: number }>()
  async get(key: string) { return this.items.get(key) ?? { state: EMPTY_STATE, version: 0 } }
  async put(key: string, state: ThrottleState, expectedVersion: number) {
    const cur = this.items.get(key)?.version ?? 0
    if (cur !== expectedVersion) return false
    this.items.set(key, { state, version: cur + 1 })
    return true
  }
}

export class FakeAuth implements AuthPort {
  users = new Map<string, string>([['alice', 'Correct-Horse-1']])
  logins = 0
  refreshes = 0
  signedOut: string[] = []
  refreshValid = true
  constructor(public clock: { now(): number }) {}
  async login(u: string, p: string) {
    this.logins++
    if (this.users.get(u.toLowerCase()) !== p) throw new AuthFailed()
    return { accessToken: accessToken(Math.floor(this.clock.now() / 1000) + 3600), expiresIn: 3600, refreshToken: 'refresh-token-value' }
  }
  async refresh(rt: string) {
    this.refreshes++
    if (!this.refreshValid || rt !== 'refresh-token-value') throw new AuthFailed()
    return { accessToken: accessToken(Math.floor(this.clock.now() / 1000) + 3600), expiresIn: 3600 }
  }
  async globalSignOut(u: string) { this.signedOut.push(u) }
}

/** 模拟 AgentCore：按调用序列返回状态；200 时返回封包响应 */
export class FakeRuntime implements RuntimePort {
  calls: { payload: Record<string, unknown>; sessionId: string; token: string }[] = []
  statuses: number[] = []
  reply = { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['pref=1; Path=/'] } as Record<string, string | string[]>, body: 'hello from dsh' }
  async invoke(payload: Buffer, sessionId: string, token: string) {
    this.calls.push({ payload: JSON.parse(payload.toString('utf8')) as Record<string, unknown>, sessionId, token })
    const status = this.statuses.shift() ?? 200
    const wire = Buffer.concat([encodeResponseHead({ status: this.reply.status, headers: this.reply.headers }), Buffer.from(this.reply.body)])
    return {
      status,
      body: status === 200 ? (async function* () { yield wire.subarray(0, 5); yield wire.subarray(5) })() : null,
      text: async () => (status === 200 ? '' : `{"message":"status ${status}"}`),
    }
  }
}

export function makeDeps(now = 1_800_000_000_000): Deps & { auth: FakeAuth; throttle: MemThrottle; runtime: FakeRuntime; logs: string[]; clock: { t: number; now(): number } } {
  const clock = { t: now, now() { return this.t } }
  const logs: string[] = []
  return {
    cfg: { originSecret: 'origin-secret', refreshTokenMaxAgeSeconds: 86_400, refreshSkewSeconds: 300 },
    auth: new FakeAuth(clock), throttle: new MemThrottle(), runtime: new FakeRuntime(), clock, logs,
    log: (level, msg, fields) => { logs.push(JSON.stringify({ level, msg, ...fields })) },
  }
}

export function event(p: Partial<FunctionUrlEvent> & { method?: string } = {}): FunctionUrlEvent {
  const { method = 'GET', ...rest } = p
  return { rawPath: '/', headers: { 'x-origin-verify': 'origin-secret' }, cookies: [], requestContext: { http: { method } }, ...rest }
}
export const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

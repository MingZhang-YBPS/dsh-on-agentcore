// 隧道 Lambda 依赖的外部能力（Cognito、DynamoDB、AgentCore、时钟）。handler.ts 只依赖这些接口，
// index.ts 提供 AWS SDK 实现，测试提供内存实现。

import type { ThrottleState } from '@dsh-poc/auth-throttle'

export interface Tokens { accessToken: string; expiresIn: number; refreshToken?: string }

export interface AuthPort {
  /** 口令认证；凭证错误或用户不存在时抛 AuthFailed */
  login(username: string, password: string): Promise<Tokens>
  /** 用刷新令牌换新的访问令牌；刷新令牌无效（已登出、过期）时抛 AuthFailed */
  refresh(refreshToken: string, username: string): Promise<Tokens>
  /** 让该用户的全部刷新令牌失效 */
  globalSignOut(username: string): Promise<void>
}

export class AuthFailed extends Error {
  constructor(message = 'authentication failed') { super(message); this.name = 'AuthFailed' }
}

export interface ThrottleStore {
  /** 返回状态与乐观并发版本号（不存在时 version=0） */
  get(key: string): Promise<{ state: ThrottleState; version: number }>
  /** 条件写：版本号不等于 expectedVersion 时返回 false */
  put(key: string, state: ThrottleState, expectedVersion: number, ttlEpochSeconds: number): Promise<boolean>
}

export interface RuntimePort {
  /** 以 Bearer 令牌调用 InvokeAgentRuntime（/invocations），返回 HTTP 状态与响应体流 */
  invoke(payload: Buffer, sessionId: string, accessToken: string): Promise<{ status: number; body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }>
}

export interface ResponseWriter {
  write(chunk: Uint8Array | string): void
  end(): void
}
/** 打开一个流式响应：先确定状态码、响应头与 cookie，再写响应体 */
export type OpenResponse = (status: number, headers: Record<string, string>, cookies?: readonly string[]) => ResponseWriter

export interface Clock { now(): number }

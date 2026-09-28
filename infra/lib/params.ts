// 部署参数：全部来自 CDK context（cdk.json 默认值，或 -c key=value 覆盖），不需改动源码。

import type { Node } from 'constructs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Surface = 'bedrock-runtime' | 'bedrock-mantle'

export interface Params {
  modelId: string
  modelRegion: string
  modelEndpointSurface: Surface
  tokenValidityHours: number
  refreshTokenValidityDays: number
  tokenRefreshSkewSeconds: number
  idleRuntimeSessionTimeoutSeconds: number
  maxLifetimeSeconds: number
  wsKeepaliveMs: number
  wsFrameMax: number
  homeMirrorIntervalMs: number
  dshReadyTimeoutMs: number
  demoUsers: string[]
  logRetentionDays: number
  /** 适配器代码包（infra/scripts/build-adapter.sh 的输出） */
  adapterZip: string
  /** 测试部署：容器内使用模拟模型（不调用 Bedrock） */
  mockModel: boolean
}

export const surfaceBase = (s: Surface, region: string): string =>
  s === 'bedrock-runtime' ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1` : `https://bedrock-mantle.${region}.api.aws/v1`
export const surfaceService = (s: Surface): string => (s === 'bedrock-runtime' ? 'bedrock' : 'bedrock-mantle')

export function readParams(node: Node, stackRegion: string): Params {
  const raw = (k: string): unknown => node.tryGetContext(k)
  const str = (k: string, d?: string): string => { const v = raw(k); return v === undefined || v === null || v === '' ? (d ?? '') : String(v) }
  const num = (k: string, d: number): number => { const v = raw(k); const n = v === undefined ? d : Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`context ${k} must be a positive number`); return n }
  const bool = (k: string): boolean => ['true', '1', 'yes'].includes(String(raw(k) ?? 'false').toLowerCase())
  const surface = str('modelEndpointSurface', 'bedrock-runtime')
  if (surface !== 'bedrock-runtime' && surface !== 'bedrock-mantle') throw new Error('context modelEndpointSurface must be bedrock-runtime or bedrock-mantle')
  const p: Params = {
    modelId: str('modelId'),
    modelRegion: str('modelRegion', stackRegion),
    modelEndpointSurface: surface,
    tokenValidityHours: num('tokenValidityHours', 12),
    refreshTokenValidityDays: num('refreshTokenValidityDays', 1),
    tokenRefreshSkewSeconds: num('tokenRefreshSkewSeconds', 300),
    idleRuntimeSessionTimeoutSeconds: num('idleRuntimeSessionTimeoutSeconds', 900),
    maxLifetimeSeconds: num('maxLifetimeSeconds', 28800),
    wsKeepaliveMs: num('wsKeepaliveMs', 20000),
    wsFrameMax: num('wsFrameMax', 49152),
    homeMirrorIntervalMs: num('homeMirrorIntervalMs', 2000),
    dshReadyTimeoutMs: num('dshReadyTimeoutMs', 90000),
    demoUsers: str('demoUsers', 'demo').split(',').map((s) => s.trim()).filter(Boolean),
    logRetentionDays: num('logRetentionDays', 14),
    adapterZip: str('adapterZip', join(homedir(), '.cache', 'dsh-poc', 'adapter-build', 'adapter.zip')),
    mockModel: bool('mockModel'),
  }
  if (!p.modelId) throw new Error('context modelId is required')
  if (p.idleRuntimeSessionTimeoutSeconds > p.maxLifetimeSeconds) throw new Error('idleRuntimeSessionTimeoutSeconds must be <= maxLifetimeSeconds')
  if (p.maxLifetimeSeconds > 28800) throw new Error('maxLifetimeSeconds must be <= 28800 on microVM runtimes')
  if (p.wsFrameMax >= 65536) throw new Error('wsFrameMax must be below the AgentCore 64 KB frame limit')
  if (p.tokenRefreshSkewSeconds >= p.tokenValidityHours * 3600) throw new Error('tokenRefreshSkewSeconds must be shorter than the token validity')
  for (const u of [...p.demoUsers, 'ops']) if (!/^[a-z][a-z0-9_-]{1,31}$/.test(u)) throw new Error(`invalid user name ${u}`)
  if (new Set([...p.demoUsers, 'ops']).size !== p.demoUsers.length + 1) throw new Error('demoUsers must be unique and must not include ops')
  return p
}

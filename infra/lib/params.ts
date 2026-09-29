// 部署参数：全部来自 CDK context（cdk.json 默认值，或 -c key=value 覆盖），不需改动源码。

import type { Node } from 'constructs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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


// ---- 每用户 Runtime + EFS 部署（DshPerUser 栈）的附加参数 ----

/**
 * AgentCore Runtime 支持 VPC 连接的可用区 ID（https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html，2026-09 查阅）。
 * 子网按可用区 ID（而不是名称）创建，名称到 ID 的映射因账号而异。表里没有的区域需要 -c vpcAzIds=id1,id2。
 */
export const AGENTCORE_VPC_AZ_IDS: Readonly<Record<string, readonly string[]>> = {
  'us-east-1': ['use1-az1', 'use1-az2', 'use1-az4'],
  'us-east-2': ['use2-az1', 'use2-az2', 'use2-az3'],
  'us-west-1': ['usw1-az1', 'usw1-az3'],
  'us-west-2': ['usw2-az1', 'usw2-az2', 'usw2-az3'],
  'ap-southeast-5': ['apse5-az1', 'apse5-az2', 'apse5-az3'],
  'ap-south-1': ['aps1-az1', 'aps1-az2', 'aps1-az3'],
  'ap-south-2': ['aps2-az1', 'aps2-az2', 'aps2-az3'],
  'ap-northeast-2': ['apne2-az1', 'apne2-az2', 'apne2-az3'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2', 'apse1-az3'],
  'ap-southeast-2': ['apse2-az1', 'apse2-az2', 'apse2-az3'],
  'ca-central-1': ['cac1-az1', 'cac1-az2', 'cac1-az4'],
  'eu-central-1': ['euc1-az1', 'euc1-az2', 'euc1-az3'],
  'eu-west-1': ['euw1-az1', 'euw1-az2', 'euw1-az3'],
  'eu-west-2': ['euw2-az1', 'euw2-az2', 'euw2-az3'],
  'eu-south-1': ['eus1-az1', 'eus1-az2', 'eus1-az3'],
  'eu-west-3': ['euw3-az1', 'euw3-az2', 'euw3-az3'],
  'eu-south-2': ['eus2-az1', 'eus2-az2', 'eus2-az3'],
  'eu-north-1': ['eun1-az1', 'eun1-az2', 'eun1-az3'],
  'sa-east-1': ['sae1-az1', 'sae1-az2', 'sae1-az3'],
}

export interface PerUserParams {
  /** 新建 VPC 的 CIDR（必须是 /16；切成 /20：每个可用区一个公有子网放 NAT、一个私有子网放 Runtime 与 EFS 挂载目标） */
  vpcCidr: string
  /**
   * 一个或两个可用区 ID，默认一个。每个可用区一个 NAT 网关。
   * 单可用区：没有跨可用区流量费、每名用户一个挂载目标；该可用区故障时服务不可用（EFS 为区域级存储，数据不受影响）。
   */
  vpcAzIds: string[]
  /** EFS 访问点的 POSIX 身份：所有文件操作都以它执行（Spike 03 实测 NODE_22 代码运行时的进程 uid 为 991） */
  efsPosixUid: number
  efsPosixGid: number
  /** EFS 自动备份（AWS Backup 默认计划，恢复点在栈删除后仍保留，另行计费） */
  efsBackup: boolean
  /** 每用户 Runtime 的代码包：adapter.zip + per-user-entry.js（build-adapter.sh 第 5 步的输出，与 adapter.zip 同目录） */
  adapterZip: string
  /**
   * 使用自己 DeepSeek API key 的用户（context deepseekSecretPerUser：逗号分隔的用户名，或 * 表示全部）。
   * 这些用户各有一个 secret，执行角色只能读自己的；其余用户共用主栈的 secret。key 的值不经过 context 或模板，
   * 由部署包装器从环境变量 DEEPSEEK_API_KEY_<用户名大写，- 换成 _> 写入（共享 secret 用 DEEPSEEK_API_KEY）。
   */
  deepseekSecretPerUser: string[]
}

/** 某用户独立 DeepSeek key 的环境变量名 */
export const userDeepSeekKeyEnv = (user: string): string => `DEEPSEEK_API_KEY_${user.toUpperCase().replace(/-/g, '_')}`

/** 每名用户的 Runtime 名称（账号区域内唯一；Runtime 名称只允许字母、数字与下划线） */
export const userRuntimeName = (user: string): string => `dsh_pu_${user.replace(/-/g, '_')}`

export function readPerUserParams(node: Node, stackRegion: string, p: Params): PerUserParams {
  const raw = (k: string): unknown => node.tryGetContext(k)
  const str = (k: string, d: string): string => { const v = raw(k); return v === undefined || v === null || v === '' ? d : String(v) }
  const uint = (k: string, d: number): number => { const n = Number(str(k, String(d))); if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw new Error(`context ${k} must be a non-negative integer`); return n }
  const vpcCidr = str('vpcCidr', '10.80.0.0/16')
  if (!/^(\d{1,3}\.){3}\d{1,3}\/16$/.test(vpcCidr)) throw new Error('context vpcCidr must be an IPv4 /16 CIDR, for example 10.80.0.0/16')
  const supported = AGENTCORE_VPC_AZ_IDS[stackRegion]
  const azIds = str('vpcAzIds', (supported ?? []).slice(0, 1).join(',')).split(',').map((s) => s.trim()).filter(Boolean)
  if (azIds.length < 1 || azIds.length > 2 || new Set(azIds).size !== azIds.length) {
    throw new Error(supported ? 'context vpcAzIds must list one or two different availability zone IDs' : `region ${stackRegion} is not in the AgentCore VPC availability zone table; pass -c vpcAzIds=<az-id>[,<az-id>]`)
  }
  if (supported) for (const az of azIds) if (!supported.includes(az)) throw new Error(`availability zone ${az} does not support AgentCore VPC connectivity in ${stackRegion} (supported: ${supported.join(', ')})`)
  const names = p.demoUsers.map(userRuntimeName)
  if (new Set(names).size !== names.length) throw new Error('demoUsers must stay unique after replacing "-" with "_" (Runtime names)')
  return {
    vpcCidr,
    vpcAzIds: azIds,
    efsPosixUid: uint('efsPosixUid', 991),
    efsPosixGid: uint('efsPosixGid', 991),
    efsBackup: ['true', '1', 'yes'].includes(String(raw('efsBackup') ?? 'false').toLowerCase()),
    adapterZip: str('adapterPerUserZip', join(dirname(p.adapterZip), 'adapter-per-user.zip')),
    deepseekSecretPerUser: perUserKeys(str('deepseekSecretPerUser', ''), p.demoUsers),
  }
}

function perUserKeys(raw: string, users: readonly string[]): string[] {
  const list = raw.trim() === '*' ? [...users] : raw.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = list.filter((u) => !users.includes(u))
  if (unknown.length) throw new Error(`deepseekSecretPerUser lists users that are not in demoUsers: ${unknown.join(', ')}`)
  return [...new Set(list)]
}

// 适配器配置：全部来自环境变量（AgentCore Runtime 的 environmentVariables）。

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AdapterConfig {
  port: number
  dshPort: number
  userHome: string
  workspaceDir: string
  /** DSH_HOME 的持久副本（session storage 上） */
  dshHomePersist: string
  /** DSH 实际运行的 DSH_HOME；开启镜像时在本地盘 */
  dshHomeLocal: string
  mirror: boolean
  mirrorIntervalMs: number
  patches: string[]
  requireSessionOwner: boolean
  dshReadyTimeoutMs: number
  wsKeepaliveMs: number
  wsFrameMax: number
  model: {
    id: string
    region: string
    baseUrl: string
    signingService: string
    stripRawToolMarkup: boolean
    /** 测试用：容器内启动模拟上游并用假凭证签名 */
    mock: boolean
    /** 测试用：上游是本机模拟服务时用假凭证签名（不让真实凭证的签名离开进程） */
    fakeCredentials: boolean
  }
  /** DeepSeek（api.deepseek.com）网页搜索：key 由适配器内的本地代理注入，DSH 只拿到占位值 */
  deepseek: {
    /** 部署时的 Secrets Manager secret（存放 DeepSeek API key）；空表示未配置 */
    keySecretArn: string | undefined
    /** 仅限本机开发与测试：直接给出 key（部署时从不设置） */
    staticKey: string | undefined
    upstream: string
    keyCacheMs: number
  }
  /** 新会话的默认模型：auto（配置了 DeepSeek key 时用 DeepSeek 官方，否则 Bedrock）或 bedrock */
  defaultModel: 'auto' | 'bedrock'
  egressProxy: string | undefined
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** 包根目录：开发时是 services/adapter，部署包里是 app.js 所在目录（补丁 dsh/*.yml 相对它解析） */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return process.env.ADAPTER_PACKAGE_ROOT ?? (/[\\/](src|dist)$/.test(here) ? join(here, '..') : here)
}

const num = (v: string | undefined, d: number, name: string): number => {
  if (v === undefined || v === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}
const bool = (v: string | undefined, d: boolean): boolean => (v === undefined || v === '' ? d : !['0', 'false', 'no'].includes(v.toLowerCase()))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const userHome = resolve(env.USER_HOME ?? '/mnt/workspace')
  const mirror = bool(env.DSH_HOME_MIRROR, true)
  const dshHomePersist = resolve(env.DSH_HOME ?? join(userHome, '.dsh'))
  const root = packageRoot()
  const wsFrameMax = num(env.WS_FRAME_MAX, 48 * 1024, 'WS_FRAME_MAX')
  if (wsFrameMax >= 64 * 1024) throw new Error('WS_FRAME_MAX must be below the AgentCore 64 KB frame limit')
  const mock = bool(env.MOCK_MODEL, false)
  const baseUrl = env.MODEL_BASE_URL ?? ''
  if (!mock && !baseUrl) throw new Error('MODEL_BASE_URL is required unless MOCK_MODEL=1')
  return {
    port: num(env.PORT, 8080, 'PORT'),
    dshPort: num(env.DSH_PORT, 3080, 'DSH_PORT'),
    userHome,
    workspaceDir: resolve(env.WORKSPACE_DIR ?? join(userHome, 'workspace')),
    dshHomePersist,
    dshHomeLocal: mirror ? resolve(env.DSH_HOME_LOCAL ?? '/tmp/dsh-home') : dshHomePersist,
    mirror,
    mirrorIntervalMs: num(env.DSH_HOME_MIRROR_MS, 2000, 'DSH_HOME_MIRROR_MS'),
    patches: (env.DSH_PATCHES ?? 'dsh/web.cordis.yml,dsh/web-hardening.cordis.yml').split(',').filter(Boolean).map((p) => resolve(root, p)),
    requireSessionOwner: bool(env.REQUIRE_SESSION_OWNER, true),
    dshReadyTimeoutMs: num(env.DSH_READY_TIMEOUT_MS, 90_000, 'DSH_READY_TIMEOUT_MS'),
    wsKeepaliveMs: num(env.WS_KEEPALIVE_MS, 20_000, 'WS_KEEPALIVE_MS'),
    wsFrameMax,
    model: {
      id: env.MODEL_ID ?? 'deepseek.v3.2',
      region: env.MODEL_REGION ?? env.AWS_REGION ?? 'us-east-1',
      baseUrl,
      signingService: env.MODEL_SIGNING_SERVICE ?? 'bedrock',
      stripRawToolMarkup: bool(env.MODEL_STRIP_RAW_TOOL_MARKUP, true),
      mock,
      fakeCredentials: mock || bool(env.SIGNER_FAKE_CREDS, false),
    },
    deepseek: {
      keySecretArn: env.DEEPSEEK_KEY_SECRET_ARN || undefined,
      staticKey: env.DEEPSEEK_API_KEY_LOCAL || undefined,
      upstream: (env.DEEPSEEK_UPSTREAM || 'https://api.deepseek.com').replace(/\/$/, ''),
      keyCacheMs: num(env.DEEPSEEK_KEY_CACHE_MS, 300_000, 'DEEPSEEK_KEY_CACHE_MS'),
    },
    defaultModel: env.DEFAULT_MODEL === 'bedrock' ? 'bedrock' : 'auto',
    egressProxy: env.EGRESS_PROXY || undefined,
    logLevel: (['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL ?? '') ? env.LOG_LEVEL : 'info') as AdapterConfig['logLevel'],
  }
}

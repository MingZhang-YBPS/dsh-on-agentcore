// 启动官方 `dsh web` 子进程并代办它的本地鉴权：
// 启动完成时 DSH 在 stdout 打印 `http://127.0.0.1:<port>/?token=<一次性令牌>`；适配器用它换取绑定 Host 的
// HMAC cookie（dsh-auth-*），此后每个转发请求都带上该 cookie、并把 Host 改写为 127.0.0.1:<port>。

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { AdapterConfig } from './config.js'
import type { Logger } from '@dsh-poc/log'

export interface DshHandle {
  child: ChildProcess
  cookie: string
  authority: string
  readyMs: number
}

export function dshBin(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
}

const LAUNCH_URL = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/

/** 适配器提供给 DSH 的本地服务（补丁 web.cordis.yml 通过 !!js process.env.* 引用） */
export interface DshBridge {
  signerBase: string
  deepseekBase: string
  /** 部署是否配置了 DeepSeek API key：只在配置时设置占位引用（网页搜索卡片显示「已配置密钥」、llm-deepseek 行启用） */
  deepseekKeyConfigured: boolean
}

/** DeepSeek 官方模型的默认选择（配置了 key 且没有指定 DEFAULT_MODEL=bedrock 时） */
export const DEEPSEEK_DEFAULT = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

export function defaultModel(cfg: Pick<AdapterConfig, 'defaultModel' | 'model'>, deepseekKeyConfigured: boolean): { provider: string; model: string } {
  const useDeepSeek = deepseekKeyConfigured && cfg.defaultModel !== 'bedrock'
  return useDeepSeek ? { ...DEEPSEEK_DEFAULT } : { provider: 'bedrock', model: cfg.model.id }
}

export async function startDsh(cfg: AdapterConfig, bridge: DshBridge, log: Logger, onExit: (code: number | null, signal: string | null) => void): Promise<DshHandle> {
  const t0 = Date.now()
  mkdirSync(cfg.workspaceDir, { recursive: true })
  mkdirSync(cfg.dshHomeLocal, { recursive: true })
  const authority = `127.0.0.1:${cfg.dshPort}`
  const dflt = defaultModel(cfg, bridge.deepseekKeyConfigured)
  const args = [dshBin(), '--profile', 'web', ...cfg.patches.flatMap((p) => ['--patch', p]), '--port', String(cfg.dshPort), '--no-open']
  const proxyEnv: Record<string, string> = cfg.egressProxy ? { HTTP_PROXY: cfg.egressProxy, HTTPS_PROXY: cfg.egressProxy, ALL_PROXY: cfg.egressProxy, NO_PROXY: '' } : {}
  const child = spawn(process.execPath, args, {
    cwd: cfg.workspaceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: cfg.userHome,
      DSH_HOME: cfg.dshHomeLocal, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED',
      // web.cordis.yml 通过 !!js process.env.* 读取以下各项；两个 *_KEY 都只是占位值（真实凭证由本地代理注入），
      // 名称含 KEY，DSH 启动子进程时会把它们从环境中剔除
      DSH_BRIDGE_MODEL_ID: cfg.model.id, DSH_BRIDGE_MODEL_BASE_URL: `${bridge.signerBase}/openai/v1`, DSH_BRIDGE_PLACEHOLDER_KEY: 'placeholder-not-a-secret',
      DSH_BRIDGE_DEEPSEEK_API_BASE: bridge.deepseekBase,
      DSH_BRIDGE_DEFAULT_PROVIDER: dflt.provider, DSH_BRIDGE_DEFAULT_MODEL: dflt.model,
      ...(bridge.deepseekKeyConfigured ? { DSH_BRIDGE_DEEPSEEK_KEY: 'placeholder-injected-by-adapter' } : {}),
      ...proxyEnv,
    },
  })
  child.stderr?.on('data', (d: Buffer) => { for (const line of d.toString('utf8').split('\n').filter(Boolean)) log('debug', 'dsh stderr', { line: line.slice(0, 300) }) })
  child.on('exit', (code, signal) => onExit(code, signal))
  const launch = await new Promise<string>((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error(`dsh web did not print its launch URL in 120 s; stdout tail: ${buf.slice(-300).replace(/token=\S+/g, 'token=<redacted>')}`)), 120_000)
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const m = LAUNCH_URL.exec(buf)
      if (m) { clearTimeout(t); res(m[1] as string) }
    })
    child.on('exit', () => { clearTimeout(t); rej(new Error('dsh exited before ready')) })
  })
  // 换取 cookie（303 + Set-Cookie: dsh-auth-<hash(authority)>=...）
  const r = await fetch(launch, { redirect: 'manual', headers: { host: authority } })
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0] as string).find((c) => c.startsWith('dsh-auth-'))
  if (r.status !== 303 || !cookie) throw new Error(`dsh token exchange failed: HTTP ${r.status}`)
  return { child, cookie, authority, readyMs: Date.now() - t0 }
}

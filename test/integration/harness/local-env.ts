// 本机集成环境：外联记录代理 + 模拟模型上游 + 适配器（子进程，dist/cli.js）+ 本机网关。
// 适配器与生产配置一致（加固补丁、DSH_HOME 镜像），只是 REQUIRE_SESSION_OWNER=0、模型上游为本机模拟服务、签名用假凭证。

import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { startMockUpstream, type MockRequest } from '@dsh-poc/adapter/mock-upstream'
import { startLocalGateway } from './local-gateway.js'

export const REPO = join(import.meta.dirname, '..', '..', '..')
/** 本机集成环境里注入的 DeepSeek key（测试值） */
export const LOCAL_DEEPSEEK_KEY = 'sk-local-integration-test'

export async function startEgressRecorder(): Promise<{ url: string; attempts: { kind: string; target: string }[]; close(): Promise<void> }> {
  const attempts: { kind: string; target: string }[] = []
  const server = http.createServer((req, res) => { attempts.push({ kind: 'http', target: req.url ?? '' }); res.writeHead(403); res.end('egress blocked') })
  server.on('connect', (req, socket) => { attempts.push({ kind: 'connect', target: req.url ?? '' }); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, attempts, close: () => new Promise<void>((r) => server.close(() => r())) }
}

export interface LocalEnv {
  root: string
  adapter: ChildProcess
  logs: string[]
  mock: { requests: MockRequest[] }
  egress: { attempts: { kind: string; target: string }[] }
  gateway: Awaited<ReturnType<typeof startLocalGateway>>
  readyMs: number
  /** 停止适配器（SIGTERM，触发最终同步）与网关；mock 与外联记录代理保留，供重启复用 */
  stop(): Promise<void>
}

export async function startLocalEnv({ root, gatewayPort = 0, adapterPort = 18090, dshPort = 13090, mock, egress, extraEnv = {} }: {
  root: string; gatewayPort?: number; adapterPort?: number; dshPort?: number
  /** 追加的适配器环境变量（例如 DEFAULT_MODEL=bedrock） */
  extraEnv?: Record<string, string>
  mock: Awaited<ReturnType<typeof startMockUpstream>>; egress: Awaited<ReturnType<typeof startEgressRecorder>>
}): Promise<LocalEnv> {
  const adapter = spawn(process.execPath, [join(REPO, 'services', 'adapter', 'dist', 'cli.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(adapterPort), DSH_PORT: String(dshPort), USER_HOME: join(root, 'home'),
      // 每次启动都用新的「本地盘」目录，模拟 microVM 回收后本地盘丢失、只剩持久目录
      DSH_HOME_LOCAL: join(root, `local-dsh-home-${Date.now()}`),
      REQUIRE_SESSION_OWNER: '0', LOG_LEVEL: 'debug',
      MODEL_ID: 'deepseek.v3.2', MODEL_REGION: 'us-east-1', MODEL_BASE_URL: mock.base, SIGNER_FAKE_CREDS: '1',
      EGRESS_PROXY: egress.url,
      // DeepSeek 网页搜索：本机用固定 key，上游是模拟服务（模拟 /anthropic/v1/messages）
      DEEPSEEK_API_KEY_LOCAL: LOCAL_DEEPSEEK_KEY, DEEPSEEK_UPSTREAM: mock.base,
      ...extraEnv,
    },
  })
  const logs: string[] = []
  const onData = (d: Buffer) => { for (const l of d.toString('utf8').split('\n').filter(Boolean)) logs.push(l) }
  adapter.stdout?.on('data', onData)
  adapter.stderr?.on('data', onData)
  const t0 = Date.now()
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`adapter not ready in 180 s:\n${logs.slice(-20).join('\n')}`)), 180_000)
    const iv = setInterval(() => {
      fetch(`http://127.0.0.1:${adapterPort}/ping`).then((r) => r.json() as Promise<{ status?: string }>).then((j) => { if (j.status === 'Healthy') { clearInterval(iv); clearTimeout(t); res() } }, () => {})
    }, 300)
    adapter.on('exit', (c) => { clearInterval(iv); clearTimeout(t); rej(new Error(`adapter exited ${c}:\n${logs.slice(-20).join('\n')}`)) })
  })
  const readyMs = Date.now() - t0
  const gateway = await startLocalGateway({ port: gatewayPort, adapterUrl: `http://127.0.0.1:${adapterPort}` })
  return {
    root, adapter, logs, mock, egress, gateway, readyMs,
    async stop() {
      await gateway.close()
      if (adapter.exitCode === null) {
        adapter.kill('SIGTERM')
        await new Promise<void>((r) => { const t = setTimeout(() => { adapter.kill('SIGKILL'); r() }, 10_000); adapter.once('exit', () => { clearTimeout(t); r() }) })
      }
    },
  }
}

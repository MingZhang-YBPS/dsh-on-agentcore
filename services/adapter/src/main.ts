// 容器内适配器入口：满足 AgentCore Runtime 的 HTTP 协议契约（:8080 GET /ping、POST /invocations、WebSocket /ws），
// 把官方 `dsh web` 隧道出去。DSH 只监听 127.0.0.1，浏览器永远不直接接触它。
//   GET /ping          DSH 就绪前 HealthyBusy，之后 Healthy
//   POST /invocations  HTTP 隧道（tunnel.ts）
//   /ws（升级）         WebSocket 对接（ws-bridge.ts）
// 其余：DSH_HOME 镜像（home-mirror.ts）、SigV4 签名代理（signing-proxy.ts）、SIGTERM 时最终同步。

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createLogger } from '@dsh-poc/log'
import { sessionOwnerRejection } from '@dsh-poc/session-identity'
import { loadConfig } from './config.js'
import { restoreHome, startHomeMirror, type HomeMirror } from './home-mirror.js'
import { startSigningProxy } from './signing-proxy.js'
import { secretKeySource, startDeepSeekProxy, staticKeySource, type KeySource } from './deepseek-proxy.js'
import { startMockUpstream } from './mock-upstream.js'
import { defaultModel, startDsh, type DshHandle } from './dsh-process.js'
import { handleInvocation } from './tunnel.js'
import { bridgeWebSocket } from './ws-bridge.js'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ server: http.Server; stop(): Promise<void> }> {
  const cfg = loadConfig(env)
  const log = createLogger({ minLevel: cfg.logLevel })
  const startedAt = Date.now()
  let dsh: DshHandle | null = null
  let mirror: HomeMirror | null = null
  let shuttingDown = false
  let markReady: (v: DshHandle) => void = () => {}
  const ready = new Promise<DshHandle>((r) => { markReady = r })
  const whenReady = (ms: number) =>
    Promise.race([ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dsh not ready')), ms).unref())]).then((d) => ({ authority: d.authority, cookie: d.cookie }))

  // ---- 模型签名代理 ----
  let upstreamBase = cfg.model.baseUrl
  let deepseekUpstream = cfg.deepseek.upstream
  let credentials: Parameters<typeof startSigningProxy>[0]['credentials']
  if (cfg.model.mock) {
    const mock = await startMockUpstream()
    upstreamBase = mock.base
    // 模拟上游同时模拟 DeepSeek 搜索端点（未显式指定 DEEPSEEK_UPSTREAM 时）
    if (!env.DEEPSEEK_UPSTREAM) deepseekUpstream = mock.base
    credentials = { accessKeyId: 'AKIDMOCKMODEL', secretAccessKey: 'mock-secret-key' }
    log('info', 'mock model upstream up', { base: mock.base })
  } else if (cfg.model.fakeCredentials) {
    credentials = { accessKeyId: 'AKIDFAKESIGNER', secretAccessKey: 'fake-signer-secret' }
  } else {
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node')
    credentials = defaultProvider()
  }
  const signer = await startSigningProxy({
    upstreamBase, region: cfg.model.region, service: cfg.model.signingService, credentials, stripRawToolMarkup: cfg.model.stripRawToolMarkup,
    onCall: (s) => log(s.status === 200 && !s.error ? 'info' : 'warn', 'model call', { ...s }),
  })

  // ---- DeepSeek 网页搜索代理（key 来自 Secrets Manager，由执行角色读取；本机测试可用 DEEPSEEK_API_KEY_LOCAL） ----
  const keys: KeySource = cfg.deepseek.keySecretArn && !cfg.model.fakeCredentials
    ? secretKeySource({ secretArn: cfg.deepseek.keySecretArn, credentials: (await import('@aws-sdk/credential-provider-node')).defaultProvider(), cacheMs: cfg.deepseek.keyCacheMs })
    : staticKeySource(cfg.deepseek.staticKey)
  const deepseek = await startDeepSeekProxy({
    upstream: deepseekUpstream, keys,
    onCall: (s) => log(s.status === 200 && !s.error ? 'info' : 'warn', 'deepseek call', { ...s }),
  })
  // 启动时查一次 key 是否已配置（决定网页搜索卡片的显示）；读取失败按未配置处理，代理之后仍会按需重试
  const deepseekKeyConfigured = await Promise.race([
    keys.get().then(Boolean, (e: Error) => { log('warn', 'deepseek key lookup failed', { error: e.message }); return false }),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref()),
  ])

  // ---- HTTP / WebSocket ----
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: dsh ? 'Healthy' : 'HealthyBusy', time_of_last_update: Math.floor(Date.now() / 1000) }))
      return
    }
    if (req.method === 'POST' && (req.url ?? '').startsWith('/invocations')) return handleInvocation(req, res, { requireSessionOwner: cfg.requireSessionOwner, readyTimeoutMs: cfg.dshReadyTimeoutMs, whenReady, log })
    res.writeHead(404); res.end()
  })
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws')) { socket.destroy(); return }
    if (cfg.requireSessionOwner) {
      const rejection = sessionOwnerRejection(req.headers)
      if (rejection) { log('warn', 'ws session owner check failed', { reason: rejection }); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    }
    whenReady(cfg.dshReadyTimeoutMs).then(
      (d) => wss.handleUpgrade(req, socket, head, (client) => bridgeWebSocket(client, req, { ...d, keepaliveMs: cfg.wsKeepaliveMs, frameMax: cfg.wsFrameMax, log })),
      () => { log('warn', 'ws rejected: dsh not ready'); socket.destroy() },
    )
  })
  await new Promise<void>((r) => server.listen(cfg.port, '0.0.0.0', r))
  log('info', 'adapter listening', { port: cfg.port, signer: signer.base, model: cfg.model.id, surface: new URL(upstreamBase).host, deepseekKeyConfigured, defaultModel: defaultModel(cfg, deepseekKeyConfigured) })

  // ---- DSH_HOME 恢复与镜像，然后启动 DSH ----
  if (cfg.mirror) {
    const t = Date.now()
    const r = restoreHome(cfg.dshHomePersist, cfg.dshHomeLocal)
    mirror = startHomeMirror({ localDir: cfg.dshHomeLocal, persistDir: cfg.dshHomePersist, intervalMs: cfg.mirrorIntervalMs, log })
    log('info', 'home restore', { ...r, ms: Date.now() - t })
  }
  startDsh(cfg, { signerBase: signer.base, deepseekBase: deepseek.base, deepseekKeyConfigured }, log, (code, signal) => {
    if (shuttingDown) return
    // DSH 意外退出：适配器以非零码退出，由 AgentCore 在下一次调用时重建 microVM
    log('error', 'dsh exited unexpectedly', { code, signal })
    mirror?.stop()
    process.exit(1)
  }).then(
    (d) => { dsh = d; markReady(d); log('info', 'dsh web ready', { readyMs: Date.now() - startedAt, dshMs: d.readyMs, pid: d.child.pid }) },
    (e: Error) => { log('error', 'dsh start failed', { error: e.message }); mirror?.stop(); process.exit(1) },
  )

  const stop = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', 'shutdown requested')
    const child = dsh?.child
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((r) => { const t = setTimeout(r, 1500); child.once('exit', () => { clearTimeout(t); r() }) })
    }
    try { mirror?.stop(); log('info', 'final home mirror sync', { ...(mirror?.stats ?? {}) }) } catch (e) { log('error', 'final sync failed', { error: (e as Error).message }) }
    wss.close()
    server.close()
    await signer.close()
    await deepseek.close()
  }
  return { server, stop }
}

/** 作为进程入口运行：SIGTERM / SIGINT 时做最终同步后退出 */
export function runFromCli(): void {
  main().then(({ stop }) => {
    const onSignal = () => { void stop().then(() => process.exit(0)) }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }, (e: Error) => { console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'adapter failed to start', error: e.message })); process.exit(1) })
}

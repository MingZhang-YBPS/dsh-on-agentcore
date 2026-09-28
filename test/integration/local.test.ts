// 本机集成测试（任务 4.8）：适配器（dist/cli.js）+ 锁定版本的 dsh web + 本机网关 + 模拟模型上游 + 外联记录代理，
// 浏览器用例在 Windows 侧 Edge 上运行（test/e2e/ui/ui-suite.mjs）。覆盖：
// 模型：配置了 DeepSeek key 时默认走 DeepSeek 官方（经 DeepSeek 代理，阶段 A、G）；阶段 B、F 指定 DEFAULT_MODEL=bedrock（经签名代理）。
//   阶段 A：首次使用（U01–U06）、工作区文件落盘（L02）、停止生成关闭上游连接（L03）、设置与凭证 RPC 的服务端过滤（L10）
//   阶段 B：适配器重启（模拟 microVM 回收，同一持久目录）后会话与历史仍在（U07、L08）
//   阶段 F：长会话刷新（历史快照超过 64 KB），适配器对大消息分片（U11、L12）
//   阶段 G：插件设置页可用、模型设置页不出现、网页搜索经适配器的 DeepSeek 代理（注入部署的 key）（G01–G07、L13）
//   全程：DSH 进程无非回环外联（L11）
// 前置：npm run build（适配器从 dist 运行）；Windows 侧 WIN_UI_DIR 已安装 playwright-core@1.63.0。
// 运行：npm run test:integration -- test/integration/local.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockUpstream } from '@dsh-poc/adapter/mock-upstream'
import { createHash } from 'node:crypto'
import { LOCAL_DEEPSEEK_KEY, REPO, startEgressRecorder, startLocalEnv, type LocalEnv } from './harness/local-env.js'
import { runWindowsUi, windowsUiAvailable, type UiResult } from './harness/windows-ui.js'

const RESULTS = join(REPO, 'test', 'results', 'integration-local')
const built = existsSync(join(REPO, 'services', 'adapter', 'dist', 'cli.js'))

describe.skipIf(!built || !windowsUiAvailable())('本机集成：官方 Web UI 经适配器', () => {
  let root: string
  let mock: Awaited<ReturnType<typeof startMockUpstream>>
  let egress: Awaited<ReturnType<typeof startEgressRecorder>>
  let env: LocalEnv
  const ui = (phase: string, out: string): Promise<UiResult> => runWindowsUi('ui-suite.mjs', [`http://localhost:${env.gateway.port}/`, phase, out, 'hardened'], out, RESULTS)
  const byId = (r: UiResult, id: string) => r.cases.find((c) => c.id === id)
  const expectCase = (r: UiResult, id: string) => {
    const c = byId(r, id)
    expect(c, `${id} missing`).toBeDefined()
    expect(c?.pass, `${id}: ${c?.note ?? c?.error ?? ''}`).toBe(true)
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-poc-local-'))
    mock = await startMockUpstream()
    egress = await startEgressRecorder()
  })
  afterAll(async () => {
    await env?.stop()
    await mock?.close()
    await egress?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('阶段 A：首次使用', async () => {
    env = await startLocalEnv({ root, mock, egress })
    expect(env.readyMs).toBeLessThan(120_000)
    const r = await ui('A', 'local-A')
    for (const id of ['U01', 'U02', 'U03', 'U04', 'U05', 'U06']) expectCase(r, id)
    // L02：bash 工具写入的文件在持久目录的 ~/workspace 下
    const hello = join(root, 'home', 'workspace', 'hello.txt')
    expect(existsSync(hello) && readFileSync(hello, 'utf8')).toBe('spike05\n')
    // L03：停止生成后，到模型上游的连接被关闭
    expect(mock.requests.some((q) => JSON.stringify(q.body?.messages ?? []).includes('慢慢说[[SLOW]]') && q.clientClosedEarly)).toBe(true)
    // L10：设置与凭证 RPC 的服务端过滤：只读调用放行；模型路由、凭证写入被适配器以 RPC 失败拒绝，不到达 DSH
    const call = async (ep: string, args: Record<string, unknown>) => {
      const res = await fetch(`${env.gateway.base}/api/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `t-${Date.now()}`, method: ep, payload: { args } }) })
      return { status: res.status, body: await res.json() as { result?: { ok?: boolean; error?: { code?: string } } } }
    }
    expect((await call('settings/describe', {})).body.result?.ok).toBe(true)
    expect((await call('credentials/describe', { refs: ['DSH_BRIDGE_DEEPSEEK_KEY'] })).body.result?.ok).toBe(true)
    for (const [ep, args] of [['settings/update', { ns: 'llm-pi-ai', patch: { providers: {} } }], ['credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-x' }], ['settings/mutate', { ns: 'web-search-deepseek', ops: [{ op: 'set', path: ['apiKeyEnv'], value: 'PATH' }] }]] as const) {
      const r = await call(ep, args)
      expect(r.status, ep).toBe(200)
      expect(r.body.result?.error?.code, ep).toBe('deployment/locked')
    }
    expect(env.logs.filter((l) => l.includes('"settings rpc rejected"')).length).toBeGreaterThanOrEqual(3)
    // L14：默认模型是 DeepSeek 官方：对话请求经 DeepSeek 代理（路径 /chat/completions，不是签名代理的 /openai/v1），带代理注入的 key
    const keySha = createHash('sha256').update(LOCAL_DEEPSEEK_KEY).digest('hex')
    const chats = mock.requests.filter((q) => q.url.endsWith('/chat/completions'))
    expect(chats.length).toBeGreaterThan(0)
    expect(chats.every((q) => !q.url.startsWith('/openai/') && q.bearerSha256 === keySha && q.body?.model === 'deepseek-flash')).toBe(true)
    expect(env.gateway.stats.errors).toBe(0)
    await env.stop()
    // 之后的阶段只统计各自的请求
    mock.requests.splice(0)
  })

  it('阶段 B：适配器重启后会话与历史仍在（Bedrock 默认模型）', async () => {
    env = await startLocalEnv({ root, mock, egress, extraEnv: { DEFAULT_MODEL: 'bedrock' } })
    const r = await ui('B', 'local-B')
    expectCase(r, 'U07')
    const req = mock.requests.find((q) => JSON.stringify(q.body?.messages ?? []).includes('还记得吗'))
    const users = (req?.body?.messages ?? []).filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content))
    expect(users.some((t) => t.includes('打个招呼')) && users.some((t) => t.includes('写一个文件'))).toBe(true)
    // 新会话之外，B 在阶段 A 的旧会话里继续对话：会话沿用创建时的模型，所以这里只检查签名代理收到的请求都已签名
    const signed = mock.requests.filter((q) => q.url.startsWith('/openai/v1/'))
    expect(signed.every((q) => q.sigv4.scheme === 'AWS4-HMAC-SHA256' && q.sigv4.contentSha256Matches)).toBe(true)
    expect(env.gateway.stats.errors).toBe(0)
    // SIGTERM 时做了最终同步
    await env.stop()
    expect(env.logs.some((l) => l.includes('"final home mirror sync"'))).toBe(true)
  })

  it('阶段 F：长会话刷新，大消息分片（Bedrock 默认模型）', async () => {
    env = await startLocalEnv({ root, mock, egress, extraEnv: { DEFAULT_MODEL: 'bedrock' } })
    mock.requests.splice(0)
    const r = await ui('F', 'local-F')
    expectCase(r, 'U11')
    // L15：新会话用 Bedrock：请求经签名代理，SigV4 签名
    const f = mock.requests.filter((q) => q.url.endsWith('/chat/completions'))
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((q) => q.url.startsWith('/openai/v1/') && q.sigv4.scheme === 'AWS4-HMAC-SHA256' && q.sigv4.contentSha256Matches && q.body?.model === 'deepseek.v3.2')).toBe(true)
    expect(env.logs.some((l) => l.includes('"ws message fragmented"'))).toBe(true)
    await env.stop()
  })

  it('阶段 G：插件设置页与网页搜索', async () => {
    env = await startLocalEnv({ root, mock, egress })
    // 非回环主机名（浏览器内映射到 127.0.0.1）：复现经 CloudFront 访问时 DSH 客户端的行为
    const r = await runWindowsUi('plugins-suite.mjs', [`http://dsh-poc.test:${env.gateway.port}/`, 'local-G', '-', 'mock'], 'local-G', RESULTS)
    for (const id of ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07']) expectCase(r, id)
    // L13：DSH 发出的搜索请求经适配器代理，到达上游时带的是部署注入的 key（DSH 只有占位值）
    const searches = mock.requests.filter((q) => q.url.endsWith('/anthropic/v1/messages'))
    expect(searches.length).toBeGreaterThan(0)
    const want = createHash('sha256').update(LOCAL_DEEPSEEK_KEY).digest('hex')
    expect(searches.every((q) => q.searchKeySha256 === want)).toBe(true)
    expect(env.logs.some((l) => l.includes('"deepseek call"') && l.includes('"status":200'))).toBe(true)
    expect(env.logs.join('\n')).not.toContain(LOCAL_DEEPSEEK_KEY)
    await env.stop()
  })

  it('全程 DSH 进程无非回环外联', () => {
    expect(egress.attempts).toEqual([])
  })
})

// 本机开发/验证环境：模拟模型上游 + 外联记录代理 + 适配器（子进程）+ 本地网关。
// 启动后浏览器打开 http://localhost:${GATEWAY_PORT}/ 即可使用官方 Web UI（Windows 侧可直接访问 WSL 的 localhost）。
//   node src/test/dev.mjs [--hardening]     --hardening 额外叠加 dsh/web-hardening.cordis.yml

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockUpstream } from '../lib/mock-upstream.mjs'
import { startEgressRecorder } from '../lib/proxies.mjs'
import { startGateway } from '../gateway/local-gateway.mjs'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function startDev({ hardening = false, gatewayPort = 8000, adapterPort = 18080, dshPort = 13080, root } = {}) {
  const base = root ?? mkdtempSync(join(tmpdir(), 'spike06-'))
  const mock = await startMockUpstream({})
  const egress = await startEgressRecorder()
  const patches = [join(SPIKE_DIR, 'dsh', 'web.cordis.yml'), ...(hardening ? [join(SPIKE_DIR, 'dsh', 'web-hardening.cordis.yml')] : [])]
  const adapter = spawn(process.execPath, [join(SPIKE_DIR, 'src', 'adapter', 'index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(adapterPort), DSH_PORT: String(dshPort),
      USER_HOME: join(base, 'home'),
      // 每次启动都用新的「本地磁盘」目录，模拟 microVM 回收后本地盘丢失、只剩持久目录
      DSH_HOME_LOCAL: join(base, `local-dsh-home-${Date.now()}`),
      DSH_PATCHES: patches.join(','),
      MODEL_ID: 'us.deepseek.r1-v1:0', MODEL_REGION: 'us-east-1', MODEL_BASE_URL: mock.base,
      SIGNER_FAKE_CREDS: '1', EGRESS_PROXY: egress.url,
    },
  })
  const logs = []
  adapter.stdout.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) logs.push(l) })
  adapter.stderr.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) logs.push(l) })
  const t0 = Date.now()
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`adapter not ready in 120 s:\n${logs.slice(-30).join('\n')}`)), 120000)
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${adapterPort}/ping`)
        if ((await r.json()).status === 'Healthy') { clearInterval(iv); clearTimeout(t); res() }
      } catch { /* 未就绪 */ }
    }, 200)
    adapter.on('exit', (c) => { clearInterval(iv); clearTimeout(t); rej(new Error(`adapter exited ${c}:\n${logs.slice(-30).join('\n')}`)) })
  })
  const readyMs = Date.now() - t0
  const gateway = await startGateway({ port: gatewayPort, adapterUrl: `http://127.0.0.1:${adapterPort}` })
  return {
    base, mock, egress, adapter, gateway, logs, readyMs,
    async stop() {
      adapter.kill('SIGTERM')
      await new Promise((r) => { adapter.on('exit', r); setTimeout(r, 5000) })
      for (const s of [mock.server, egress.server, gateway.server]) s.close()
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dev = await startDev({ hardening: process.argv.includes('--hardening'), gatewayPort: Number(process.env.GATEWAY_PORT ?? 8000) })
  console.log(`ready in ${dev.readyMs} ms; open http://localhost:${dev.gateway.port}/  (state dir ${dev.base})`)
  process.on('SIGINT', async () => { await dev.stop(); process.exit(0) })
  process.on('SIGTERM', async () => { await dev.stop(); process.exit(0) })
}

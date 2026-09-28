// 适配层一侧的 DSH 驱动：spawn `dsh --profile headless --patch bridge.cordis.yml`，经 IPC 与桥接插件通信。
// 这就是任务 13.3「DSH 驱动」的最小原型。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
export const DSH_BIN = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
export const PATCH = join(SPIKE_DIR, 'bridge', 'bridge.cordis.yml')

export class DshProcess {
  constructor({ cwd, dshHome, modelId, modelBaseUrl, egressProxy, extraEnv = {} }) {
    this.events = []
    this.stdout = ''
    this.stderr = ''
    this.listeners = new Set()
    const env = {
      PATH: process.env.PATH,
      HOME: dshHome,
      LANG: 'C.UTF-8',
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_BRIDGE_MODEL_ID: modelId,
      DSH_BRIDGE_MODEL_BASE_URL: modelBaseUrl,
      DSH_BRIDGE_PLACEHOLDER_KEY: 'placeholder-not-a-secret',
      ...(egressProxy ? { HTTP_PROXY: egressProxy, HTTPS_PROXY: egressProxy, ALL_PROXY: egressProxy, NO_PROXY: '' } : {}),
      ...extraEnv,
    }
    this.spawnedAt = Date.now()
    this.child = spawn(process.execPath, [DSH_BIN, '--profile', 'headless', '--patch', PATCH], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child.stdout.on('data', (d) => { this.stdout += d })
    this.child.stderr.on('data', (d) => { this.stderr += d })
    this.child.on('message', (m) => {
      const e = { ...m, at: Date.now() }
      this.events.push(e)
      for (const l of this.listeners) l(e)
    })
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })))
  }

  waitFor(pred, timeoutMs, label) {
    const hit = this.events.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners.delete(l); reject(new Error(`timeout waiting for ${label}; stderr tail: ${this.stderr.slice(-800)}`)) }, timeoutMs)
      const l = (e) => { if (pred(e)) { clearTimeout(t); this.listeners.delete(l); resolve(e) } }
      this.listeners.add(l)
      this.exited.then((x) => { clearTimeout(t); this.listeners.delete(l); reject(new Error(`dsh exited ${JSON.stringify(x)} while waiting for ${label}; stderr tail: ${this.stderr.slice(-1500)}`)) })
    })
  }

  ready(timeoutMs = 120000) {
    return this.waitFor((e) => e.type === 'ready' || (e.type === 'error' && !e.id), timeoutMs, 'ready')
  }

  // 发起一轮并收集到 turn_end 为止的全部事件
  async prompt(id, text, { context, timeoutMs = 120000, onEvent } = {}) {
    const startIdx = this.events.length
    const sentAt = Date.now()
    const l = (e) => { if (e.id === id) onEvent?.(e) }
    this.listeners.add(l)
    this.child.send({ type: 'prompt', id, text, context })
    try {
      const end = await this.waitFor((e) => e.id === id && (e.type === 'turn_end' || e.type === 'error'), timeoutMs, `turn_end ${id}`)
      const evs = this.events.slice(startIdx).filter((e) => e.id === id)
      return { sentAt, end, events: evs }
    } finally {
      this.listeners.delete(l)
    }
  }

  cancel(id) { this.child.send({ type: 'cancel', id }) }

  async shutdown(timeoutMs = 15000) {
    const t0 = Date.now()
    if (this.child.exitCode === null) this.child.send({ type: 'shutdown' })
    const r = await Promise.race([this.exited, new Promise((res) => setTimeout(() => res(null), timeoutMs))])
    if (!r) { this.child.kill('SIGKILL'); return { forced: true, ms: Date.now() - t0 } }
    return { ...r, ms: r.at - t0 }
  }
}

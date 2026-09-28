// DSH 补丁组合校验（任务 4.5）：用锁定版本的 dsh 执行 `--dump-config`，确认
//   1. 两个补丁能组合成功；
//   2. 补丁里的每个行 id 都存在于锁定版本的配置树中（有 name，说明不是补丁凭空新增的行）；
//   3. 要关闭的行确实为 disabled，模型路由指向签名代理。
// DSH 升级时，补丁行 id 失效会在这里暴露，而不是在 microVM 里静默失效。

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshBin } from '../src/dsh-process.js'

const DIR = join(import.meta.dirname, '..', 'dsh')
const PATCHES = ['web.cordis.yml', 'web-hardening.cordis.yml'].map((f) => join(DIR, f))

function patchRows(file: string): { id: string; disabled: boolean }[] {
  const rows: { id: string; disabled: boolean }[] = []
  let cur: { id: string; disabled: boolean } | null = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^- id: (\S+)/.exec(line)
    if (m) { cur = { id: m[1] as string, disabled: false }; rows.push(cur); continue }
    if (cur && /^\s+disabled: true/.test(line)) cur.disabled = true
  }
  return rows
}

describe('DSH 补丁组合（dsh --dump-config）', () => {
  it('补丁行都存在于锁定版本中，禁用行已禁用，模型指向签名代理', { timeout: 180_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dump-'))
    try {
      const out = execFileSync(process.execPath, [dshBin(), '--profile', 'web', ...PATCHES.flatMap((p) => ['--patch', p]), '--dump-config'], {
        encoding: 'utf8', timeout: 170_000, maxBuffer: 1 << 26,
        env: { PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, '.dsh'), DSH_TELEMETRY_DISABLED: '1', DSH_BRIDGE_MODEL_ID: 'deepseek.v3.2', DSH_BRIDGE_MODEL_BASE_URL: 'http://127.0.0.1:1/openai/v1', DSH_BRIDGE_PLACEHOLDER_KEY: 'x', DSH_BRIDGE_DEEPSEEK_API_BASE: 'http://127.0.0.1:2', DSH_BRIDGE_DEEPSEEK_KEY: 'x', DSH_BRIDGE_DEFAULT_PROVIDER: 'deepseek-official', DSH_BRIDGE_DEFAULT_MODEL: 'deepseek-flash' },
      })
      // 拆成「- id: …」块
      const blocks = new Map<string, string>()
      for (const b of out.split(/\n(?=- id: )/)) { const m = /^- id: (\S+)/m.exec(b); if (m) blocks.set(m[1] as string, b) }
      for (const f of PATCHES) {
        for (const row of patchRows(f)) {
          const block = blocks.get(row.id)
          expect(block, `${row.id}（${f}）不在锁定版本的配置树中`).toBeDefined()
          expect(block, `${row.id} 没有 name：补丁行 id 可能已失效`).toMatch(/\n\s+name: /)
          if (row.disabled) expect(block, `${row.id} 未被禁用`).toMatch(/\n\s+disabled: true/)
        }
      }
      // --dump-config 打印的是未求值的 !!js 表达式：确认它们引用适配器注入的环境变量
      expect(blocks.get('llm-pi-ai')).toMatch(/DSH_BRIDGE_MODEL_BASE_URL|127\.0\.0\.1:1\/openai\/v1/)
      expect(blocks.get('llm-pi-ai')).toMatch(/openai-completions/)
      expect(blocks.get('agent-default-model')).toMatch(/DSH_BRIDGE_DEFAULT_PROVIDER/)
      expect(blocks.get('agent-default-model')).toMatch(/DSH_BRIDGE_DEFAULT_MODEL/)
      // DeepSeek 官方模型经适配器内的 DeepSeek 代理，key 引用是占位变量；没有配置 key 时整行关闭
      expect(blocks.get('llm-deepseek')).toMatch(/DSH_BRIDGE_DEEPSEEK_API_BASE/)
      expect(blocks.get('llm-deepseek')).toMatch(/apiKeyEnv: DSH_BRIDGE_DEEPSEEK_KEY/)
      expect(blocks.get('llm-deepseek')).toMatch(/disabled: .*DSH_BRIDGE_DEEPSEEK_KEY === undefined/)
      // 网页搜索走适配器内的 DeepSeek 代理，key 引用是占位变量
      expect(blocks.get('web-search-deepseek')).toMatch(/DSH_BRIDGE_DEEPSEEK_API_BASE/)
      expect(blocks.get('web-search-deepseek')).toMatch(/apiKeyEnv: DSH_BRIDGE_DEEPSEEK_KEY/)
      // 模型设置页关闭；插件设置页及其依赖开放
      expect(blocks.get('ui-settings-models')).toMatch(/\n\s+disabled: true/)
      for (const id of ['settings-controller', 'ui-settings-plugins', 'ui-settings-plugin-inventory', 'plugin-inventory']) {
        expect(blocks.get(id), `${id} 不在配置树中`).toBeDefined()
        expect(blocks.get(id), `${id} 不应被禁用`).not.toMatch(/\n\s+disabled: true/)
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

import { describe, expect, it } from 'vitest'
import { rejectionBody, settingsRpcRejection, WRITABLE_NAMESPACES } from '../src/rpc-guard.js'

const rpc = (endpoint: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: endpoint, payload: { args }, ...extra })
const check = (endpoint: string, args: Record<string, unknown> = {}, path = `/api/${endpoint}`) => settingsRpcRejection('POST', path, rpc(endpoint, args))

describe('设置与凭证 RPC 过滤', () => {
  it('与设置、凭证无关的请求一律放行', () => {
    expect(settingsRpcRejection('POST', '/api/session/list', '{}')).toBeNull()
    expect(settingsRpcRejection('GET', '/plugins/??a/client.js&rev=1', '')).toBeNull()
  })

  it('只读调用放行：settings/describe、credentials/describe', () => {
    expect(check('settings/describe')).toBeNull()
    expect(check('credentials/describe', { refs: ['DSH_BRIDGE_DEEPSEEK_KEY'] })).toBeNull()
  })

  it('插件卡片与通用设置的命名空间可以写入', () => {
    for (const ns of ['shell', 'agent-loop', 'subagent-model-selection', 'web-search-deepseek', 'ui-theme', 'locale']) {
      expect(check('settings/update', { ns, patch: { a: 1 }, expectedRevision: 'x' }), ns).toBeNull()
      expect(check('settings/replace', { ns, section: { a: 1 } }), ns).toBeNull()
      expect(check('settings/mutate', { ns, ops: [{ op: 'set', path: ['a'], value: 1 }] }), ns).toBeNull()
    }
    expect(check('settings/update', { ns: 'web-search-deepseek', patch: { maxUses: 3 } })).toBeNull()
  })

  it('模型路由与未知命名空间被拒绝', () => {
    for (const ns of ['llm-pi-ai', 'llm-deepseek', 'unknown', 42]) {
      const r = check('settings/update', { ns, patch: {} })
      expect(r, String(ns)).toMatchObject({ rpcId: 'r-1', code: 'deployment/locked' })
    }
    expect(WRITABLE_NAMESPACES.has('llm-pi-ai')).toBe(false)
  })

  it('网页搜索的 key、key 引用与接口地址不能改（对象键或 mutate 路径）', () => {
    expect(check('settings/update', { ns: 'web-search-deepseek', patch: { baseURL: 'https://x', maxUses: 3 } })).not.toBeNull()
    expect(check('settings/update', { ns: 'web-search-deepseek', patch: { apiKey: 'sk-x' } })).not.toBeNull()
    expect(check('settings/replace', { ns: 'web-search-deepseek', section: { nested: { apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' } } })).not.toBeNull()
    expect(check('settings/mutate', { ns: 'web-search-deepseek', ops: [{ op: 'set', path: ['apiKeyEnv'], value: 'X' }] })).not.toBeNull()
  })

  it('凭证写入、本机打开文件与未知方法被拒绝', () => {
    expect(check('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk' })?.message).toMatch(/managed/)
    expect(check('credentials/unset', { ref: 'DSH_BRIDGE_DEEPSEEK_KEY' })).not.toBeNull()
    expect(check('settings/openSettingsDocument')).not.toBeNull()
    expect(check('settings/openAgentPresetDirectory', { agentPreset: 'x' })).not.toBeNull()
    expect(check('settings/somethingNew')).not.toBeNull()
  })

  it('路径与请求体中的 method 不一致、方法不是 POST、请求体不可解析 → 拒绝', () => {
    expect(settingsRpcRejection('POST', '/api/settings/describe', rpc('settings/update', { ns: 'llm-pi-ai', patch: {} }))).not.toBeNull()
    expect(settingsRpcRejection('GET', '/api/settings/describe', '')).not.toBeNull()
    expect(settingsRpcRejection('POST', '/api/settings/update', 'not json')).not.toBeNull()
    // 编码与重复斜杠不能绕过
    expect(settingsRpcRejection('POST', '/api//settings%2Fupdate', rpc('settings/update', { ns: 'llm-pi-ai', patch: {} }))).not.toBeNull()
  })

  it('拒绝响应与 DSH 网关的 server-response 同形', () => {
    const r = check('credentials/set', { ref: 'X', value: 'y' })
    expect(r).not.toBeNull()
    expect(JSON.parse(rejectionBody(r as NonNullable<typeof r>))).toEqual({ type: 'server-response', rpcId: 'r-1', result: { ok: false, error: { code: 'deployment/locked', message: 'credentials are managed by this deployment', details: {} } } })
  })
})

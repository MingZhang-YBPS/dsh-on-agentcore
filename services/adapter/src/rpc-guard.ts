// 设置与凭证 RPC 的服务端过滤（插件设置页开放、模型设置页关闭）。
// DSH 的 settings-controller 对 settings.update/replace/mutate 不限制命名空间，并且总是挂载 credentials.*；
// 浏览器的这些调用都是 HTTP：POST /api/<ns>/<method>，请求体 {type:'client-request', rpcId, method, payload:{args:{…}}}。
// 适配器在转发前按下面的规则放行，其余一律以 RPC 失败响应拒绝（HTTP 200 + result.ok=false，界面按普通失败显示）。
// 这是防误用的边界，不是安全边界：用户可以在 bash 里直接改 $DSH_HOME/settings.yaml。

/** 允许写入的设置命名空间：插件设置页的四张卡片，以及通用设置、界面偏好、默认预设与默认模型选择 */
export const WRITABLE_NAMESPACES: ReadonlySet<string> = new Set([
  // 插件设置页
  'shell', 'agent-loop', 'subagent-model-selection', 'web-search-deepseek',
  // 通用设置与界面偏好
  'ui-theme', 'locale', 'ui-onboarding', 'ui-conversation', 'ui-chat',
  // 新会话的默认 agent 预设、默认权限预设、输入框里的模型选择（只能选已注册的模型）
  'agent-presets', 'permission', 'agent-default-model',
])
/** 网页搜索卡片不能改的字段：key、key 引用与接口地址（指向适配器内的 DeepSeek 代理）由部署管理；「单次请求最多搜索次数」可改 */
const LOCKED_FIELDS: Record<string, readonly string[]> = { 'web-search-deepseek': ['apiKey', 'apiKeyEnv', 'baseURL'] }
const READ_ONLY_METHODS = new Set(['settings/describe', 'settings/canOpenAgentPresetDirectory', 'credentials/describe'])
const WRITE_METHODS = new Set(['settings/update', 'settings/replace', 'settings/mutate'])

export interface RpcRejection { rpcId: string; code: string; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 负载中是否出现某个字段名（对象键，或 mutate 操作 path 数组中的一段） */
function mentions(value: unknown, field: string, depth = 0): boolean {
  if (depth > 8) return true
  if (Array.isArray(value)) return value.some((v) => v === field || mentions(v, field, depth + 1))
  if (isRecord(value)) return Object.entries(value).some(([k, v]) => k === field || mentions(v, field, depth + 1))
  return false
}

/**
 * 判断一个转发给 DSH 的请求是否要拒绝。只检查 /api/settings/* 与 /api/credentials/*，其他请求返回 null。
 * @param method HTTP 方法
 * @param path 请求路径（可带查询串）
 * @param body 请求体
 */
export function settingsRpcRejection(method: string, path: string, body: Uint8Array | string): RpcRejection | null {
  let p: string
  try { p = decodeURIComponent(path.split('?')[0] ?? '').replace(/\/+/g, '/') } catch { p = path }
  const m = /^\/api\/((settings|credentials)\/.*)$/.exec(p)
  if (!m) return null
  const endpoint = m[1] as string
  let msg: unknown
  try { msg = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')) } catch { msg = undefined }
  const rpcId = isRecord(msg) && typeof msg.rpcId === 'string' ? msg.rpcId : ''
  const reject = (message: string): RpcRejection => ({ rpcId, code: 'deployment/locked', message })
  if (method !== 'POST' || !isRecord(msg) || msg.method !== endpoint) return reject(`${endpoint} is not available in this deployment`)
  if (READ_ONLY_METHODS.has(endpoint)) return null
  if (endpoint.startsWith('credentials/')) return reject('credentials are managed by this deployment')
  if (!WRITE_METHODS.has(endpoint)) return reject(`${endpoint} is not available in this deployment`)
  const args = isRecord(msg.payload) && isRecord(msg.payload.args) ? msg.payload.args : undefined
  const ns = args?.ns
  if (typeof ns !== 'string' || !WRITABLE_NAMESPACES.has(ns)) return reject(`settings namespace ${typeof ns === 'string' ? ns : '?'} is managed by this deployment`)
  const locked = (LOCKED_FIELDS[ns] ?? []).filter((f) => mentions({ patch: args?.patch, section: args?.section, ops: args?.ops }, f))
  if (locked.length) return reject(`${ns}.${locked.join(', ')} is managed by this deployment`)
  return null
}

/** 拒绝时返回给浏览器的 RPC 失败响应（与 DSH 网关的 server-response 同形） */
export function rejectionBody(r: RpcRejection): string {
  return JSON.stringify({ type: 'server-response', rpcId: r.rpcId, result: { ok: false, error: { code: r.code, message: r.message, details: {} } } })
}

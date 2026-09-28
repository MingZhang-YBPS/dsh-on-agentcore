// 在 Node 的 vm 中执行 CloudFront Function 源码（模拟 cloudfront-js-2.0：全局只有 Buffer 等少量对象）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

export interface CfValue { value: string; multiValue?: CfValue[] }
export interface CfRequest { method: string; uri: string; querystring: Record<string, CfValue>; headers: Record<string, CfValue>; cookies: Record<string, CfValue> }
export type CfResult = CfRequest | { statusCode: number; statusDescription?: string; headers?: Record<string, CfValue> }

export const SRC_DIR = join(import.meta.dirname, '..', 'src')

export function loadFunction(file: string, replacements: Record<string, string> = {}): (event: { request: CfRequest }) => CfResult {
  let code = readFileSync(join(SRC_DIR, file), 'utf8')
  for (const [k, v] of Object.entries(replacements)) code = code.split(k).join(v)
  const ctx = vm.createContext({ Buffer })
  vm.runInContext(`${code}\n;globalThis.__handler = handler`, ctx)
  const fn = (ctx as { __handler: (e: unknown) => CfResult }).__handler
  // 每次调用都用深拷贝的事件，避免测试之间互相影响
  return (event) => JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(event))))) as CfResult
}

export const request = (p: Partial<CfRequest> = {}): { request: CfRequest } => ({ request: { method: 'GET', uri: '/', querystring: {}, headers: {}, cookies: {}, ...p } })

import { describe, expect, it } from 'vitest'
import { loadFunction, request, type CfRequest, type CfValue } from './load.js'

const RAW_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/dsh_poc-abc'
const ARN = encodeURIComponent(RAW_ARN)
const fn = loadFunction('ws-rewrite.js', { __RUNTIME_ARN__: RAW_ARN })
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const tok = (sub: unknown) => `${b64u({ alg: 'RS256' })}.${b64u({ sub })}.sig`
const SUB = '0a1b2c3d-1111-4222-8333-444455556666'

describe('ws-rewrite', () => {
  it('有效 cookie：注入 Authorization、删除 Cookie/Origin、改写 URI 与会话 ID 查询参数', () => {
    const t = tok(SUB)
    const r = fn(request({ uri: '/api/remote.mux', headers: { origin: { value: 'https://x' }, cookie: { value: `dsh_token=${t}; dsh_refresh=r` } }, cookies: { dsh_token: { value: t }, dsh_refresh: { value: 'r' } } })) as CfRequest
    expect(r.uri).toBe(`/runtimes/${ARN}/ws`)
    expect(r.headers.authorization?.value).toBe(`Bearer ${t}`)
    expect(r.headers.origin).toBeUndefined()
    expect(r.headers.cookie).toBeUndefined()
    expect(r.cookies).toEqual({})
    expect(r.querystring).toEqual({ qualifier: { value: 'DEFAULT' }, 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': { value: `dsh-user-${SUB}` } })
  })

  it('无 cookie、不是三段、payload 不可解析、sub 非 UUID → 401', () => {
    const cases: Record<string, CfValue>[] = [{}, { dsh_token: { value: '' } }, { dsh_token: { value: 'a.b' } }, { dsh_token: { value: 'a.!!!.c' } }, { dsh_token: { value: tok('../../x') } }, { dsh_token: { value: tok(42) } }]
    for (const cookies of cases) {
      const r = fn(request({ uri: '/api/remote.mux', cookies })) as { statusCode?: number }
      expect(r.statusCode).toBe(401)
    }
  })
})

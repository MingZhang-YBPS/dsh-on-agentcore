// preflight：部署前校验参数与模型可用性，30 秒硬超时。
//   npm run preflight -- [-c key=value ...]
// 检查项：
//   1. context 参数（与合成时同一套校验，见 lib/params.ts）
//   2. 当前凭证与区域；CDK bootstrap（CDKToolkit 栈）存在
//   3. 模型（mockModel=true 时跳过）：
//      bedrock-runtime：GetFoundationModelAvailability 要求 AUTHORIZED + AVAILABLE，再发一次 max_completion_tokens=1 的
//        非流式调用（Spike 07：R1 在模型列表里有，但在 OpenAI 兼容端点上 404，只查列表不够）
//      bedrock-mantle：GET /v1/models 中包含该模型
//   4. 设置了环境变量 DEEPSEEK_API_KEY 时（网页搜索用的 DeepSeek 官方 key）：GET https://api.deepseek.com/models 返回 200

import { BedrockClient, GetFoundationModelAvailabilityCommand } from '@aws-sdk/client-bedrock'
import { CloudFormationClient } from '@aws-sdk/client-cloudformation'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { Hash } from '@smithy/hash-node'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { surfaceBase, surfaceService, type Params } from '../lib/params.js'
import { describeStack, fail, loadParams, parseCli, resolveRegion, type Cli } from './common.js'

const HARD_TIMEOUT_MS = 30_000

async function signedFetch(p: Params, method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<Response> {
  const u = new URL(surfaceBase(p.modelEndpointSurface, p.modelRegion) + path)
  const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json))
  const signer = new SignatureV4({ service: surfaceService(p.modelEndpointSurface), region: p.modelRegion, credentials: defaultProvider(), sha256: Hash.bind(null, 'sha256') })
  const headers: Record<string, string> = { host: u.host, 'content-type': 'application/json', accept: 'application/json', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') }
  const signed = await signer.sign({ method, protocol: u.protocol, hostname: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body })
  const out: Record<string, string> = { ...(signed.headers as Record<string, string>) }
  delete out.host
  return fetch(u, { method, headers: out, ...(body.length ? { body } : {}), ...(signal ? { signal } : {}) })
}

const ok = (msg: string) => console.log(`  ✓ ${msg}`)

export async function preflight(cli: Cli): Promise<Params> {
  const timer = setTimeout(() => fail(`preflight exceeded the ${HARD_TIMEOUT_MS / 1000}s hard timeout`, 2), HARD_TIMEOUT_MS)
  timer.unref()
  const abort = AbortSignal.timeout(HARD_TIMEOUT_MS - 2_000)
  console.log('== preflight')
  const region = await resolveRegion()
  let p: Params
  try { p = loadParams(cli, region) } catch (e) { fail(`invalid parameters: ${(e as Error).message}`) }
  ok(`parameters valid (region ${region}, model ${p.modelId} @ ${p.modelRegion} via ${p.modelEndpointSurface}${p.mockModel ? ', mockModel' : ''})`)

  const cfn = new CloudFormationClient({ region })
  const toolkit = await describeStack(cfn, 'CDKToolkit').catch((e: Error) => fail(`cannot call CloudFormation with the current credentials: ${e.message}`))
  if (!toolkit) fail(`CDK is not bootstrapped in ${region} (run: npx cdk bootstrap)`)
  ok('credentials valid, CDK bootstrap present')

  if (p.mockModel) {
    ok('mockModel=true: model checks skipped')
  } else if (p.modelEndpointSurface === 'bedrock-runtime') {
    const bedrock = new BedrockClient({ region: p.modelRegion })
    const a = await bedrock.send(new GetFoundationModelAvailabilityCommand({ modelId: p.modelId }), { abortSignal: abort }).catch((e: Error) => fail(`GetFoundationModelAvailability(${p.modelId}) failed: ${e.name}: ${e.message}`))
    if (a.authorizationStatus !== 'AUTHORIZED' || a.regionAvailability !== 'AVAILABLE') {
      fail(`model ${p.modelId} is not usable in ${p.modelRegion}: authorizationStatus=${a.authorizationStatus} regionAvailability=${a.regionAvailability} entitlement=${a.entitlementAvailability} agreement=${a.agreementAvailability?.status}`)
    }
    ok(`model availability: AUTHORIZED, AVAILABLE`)
    const r = await signedFetch(p, 'POST', '/chat/completions', { model: p.modelId, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 1, stream: false }, abort)
      .catch((e: Error) => fail(`model call failed: ${e.message}`))
    if (r.status !== 200) fail(`model ${p.modelId} on the OpenAI-compatible endpoint returned ${r.status}: ${(await r.text()).slice(0, 300)}`)
    ok('1-token call on the OpenAI-compatible endpoint: 200')
  } else {
    const r = await signedFetch(p, 'GET', '/models', undefined, abort).catch((e: Error) => fail(`GET /v1/models failed: ${e.message}`))
    if (r.status !== 200) fail(`bedrock-mantle GET /v1/models returned ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const ids = ((await r.json()) as { data?: { id?: string }[] }).data?.map((m) => m.id) ?? []
    if (!ids.includes(p.modelId)) fail(`model ${p.modelId} is not listed by bedrock-mantle in ${p.modelRegion} (${ids.length} models listed)`)
    ok('model listed by bedrock-mantle /v1/models')
  }
  const dsKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (dsKey) {
    const r = await fetch('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${dsKey}` }, signal: abort }).catch((e: Error) => fail(`DeepSeek API check failed: ${e.message}`))
    if (r.status !== 200) fail(`DEEPSEEK_API_KEY was rejected by api.deepseek.com: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    ok('DEEPSEEK_API_KEY accepted by api.deepseek.com')
  } else {
    ok('DEEPSEEK_API_KEY not set: the stored DeepSeek key (if any) is left unchanged')
  }
  clearTimeout(timer)
  return p
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await preflight(parseCli(process.argv.slice(2), []))
  console.log('preflight passed')
}

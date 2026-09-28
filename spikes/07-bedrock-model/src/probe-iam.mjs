// IAM 探针：用环境变量里的临时凭证（由 iam-probe.sh 假设的受限角色提供）对两个端点面各发一次流式请求，
// 输出状态码与 AccessDenied 消息（消息里带有被拒绝的 IAM 动作与资源 ARN）。
// 用法：AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=… node src/probe-iam.mjs <label> [region]

import { makeClient, readSse, summarize } from './bedrock.mjs'

const label = process.argv[2] ?? 'probe'
const region = process.argv[3] ?? 'us-east-1'
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN }
const body = (model, stream) => ({ model, stream, messages: [{ role: 'user', content: 'say hi' }], max_completion_tokens: 16 })
const out = []
for (const [surface, service, model] of [['bedrock-runtime', 'bedrock', 'deepseek.v3.2'], ['bedrock-mantle', 'bedrock-mantle', 'deepseek.v3.2'], ['bedrock-mantle', 'bedrock-mantle', 'deepseek.v3.1']]) {
  for (const stream of [true, false]) {
    const c = makeClient({ region, surface, service, credentials })
    const r = await c.request('POST', '/chat/completions', body(model, stream))
    let note
    if (r.status === 200) note = stream ? `ok「${summarize((await readSse(r)).events).text.slice(0, 30)}」` : `ok ${(await r.text()).slice(0, 60)}`
    else note = (await r.text()).replace(/\s+/g, ' ').slice(0, 400)
    const row = { label, surface, model, stream, status: r.status, note }
    out.push(row)
    console.log(JSON.stringify(row))
  }
}

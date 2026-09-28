// 阶段 2 的网关传输层：HTTP 封包经 InvokeAgentRuntime（SigV4，IAM 授权的 Runtime），
// WebSocket 经 AgentCore Runtime 的 /ws 端点（SigV4 预签名 URL，会话 ID 作为查询参数）。
// 一个网关实例固定对应一个 runtimeSessionId（= 一个用户的专属 microVM 与持久目录）。

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'
import { WebSocket } from 'ws'

export function agentcoreTransport({ runtimeArn, sessionId, region, qualifier = 'DEFAULT', onInvoke }) {
  const client = new BedrockAgentCoreClient({ region, maxAttempts: 3 })
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials: defaultProvider(), sha256: Hash.bind(null, 'sha256') })
  const host = `bedrock-agentcore.${region}.amazonaws.com`
  return {
    async invoke(payload) {
      const t0 = Date.now()
      const r = await client.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn, runtimeSessionId: sessionId, qualifier,
        contentType: 'application/json', accept: 'application/octet-stream', payload,
      }))
      onInvoke?.({ ms: Date.now() - t0, statusCode: r.statusCode, sessionId: r.runtimeSessionId })
      return r.response // Node Readable（异步可迭代）
    },
    async openWebSocket() {
      const path = `/runtimes/${encodeURIComponent(runtimeArn)}/ws`
      const signed = await signer.presign({
        method: 'GET', protocol: 'https:', hostname: host, path,
        query: { qualifier, 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId },
        headers: { host },
      }, { expiresIn: 300 })
      const qs = new URLSearchParams(signed.query).toString()
      return new WebSocket(`wss://${host}${path}?${qs}`, { perMessageDeflate: false })
    },
  }
}

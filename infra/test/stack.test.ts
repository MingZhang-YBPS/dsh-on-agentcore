// CDK 合成结果的关键不变量（不访问 AWS）：
//   - Runtime 上不带任何随部署变化的值：两次合成 Runtime 属性完全相同、没有标签（Spike 08：任何变更都会清空数据）
//   - ws-rewrite 的 ARN 占位符被替换；三个行为的缓存与函数配置；/plugins/* 删除 Set-Cookie
//   - deploy 包装器的 Runtime 变更识别
import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshPocStack } from '../lib/stack.js'
import { runtimeChanged } from '../scripts/deploy-guard.js'

const zip = join(mkdtempSync(join(tmpdir(), 'dsh-poc-infra-')), 'adapter.zip')
writeFileSync(zip, 'not really a zip')

function synth(extra: Record<string, string> = {}): Template {
  const app = new App({ context: { modelId: 'deepseek.v3.2', adapterZip: zip, ...extra } })
  return Template.fromStack(new DshPocStack(app, 'DshPoc', { env: { account: '123456789012', region: 'us-east-1' } }) as Stack)
}

const one = (t: Template, type: string) => {
  const r = Object.values(t.findResources(type))
  expect(r).toHaveLength(1)
  return r[0] as { Properties: Record<string, unknown> }
}

describe('DshPoc stack', () => {
  const t = synth()

  it('Runtime：属性确定、无标签、JWT 授权器、session storage、请求头白名单', () => {
    const rt = one(t, 'AWS::BedrockAgentCore::Runtime')
    expect(rt.Properties.Tags).toBeUndefined()
    expect(one(synth(), 'AWS::BedrockAgentCore::Runtime').Properties).toEqual(rt.Properties)
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      FilesystemConfigurations: [{ SessionStorage: { MountPath: '/mnt/workspace' } }],
      RequestHeaderConfiguration: { RequestHeaderAllowlist: ['Authorization'] },
      AuthorizerConfiguration: { CustomJWTAuthorizer: { AllowedClients: Match.anyValue(), DiscoveryUrl: Match.anyValue() } },
      EnvironmentVariables: Match.objectLike({ REQUIRE_SESSION_OWNER: '1', MODEL_ID: 'deepseek.v3.2', USER_HOME: '/mnt/workspace' }),
    })
    expect(JSON.stringify(rt.Properties.EnvironmentVariables)).not.toContain('MOCK_MODEL')
  })

  it('DeepSeek API key：secret 只有占位值，Runtime 只引用 ARN，执行角色可读', () => {
    const rt = one(t, 'AWS::BedrockAgentCore::Runtime')
    const env = rt.Properties.EnvironmentVariables as Record<string, unknown>
    expect(JSON.stringify(env.DEEPSEEK_KEY_SECRET_ARN)).toMatch(/Ref/)
    t.hasResourceProperties('AWS::SecretsManager::Secret', { SecretString: 'not-configured' })
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'))
    expect(policies).toContain('secretsmanager:GetSecretValue')
    expect(t.findOutputs('DeepSeekApiKeySecretArn')).toBeDefined()
  })

  it('执行角色只能调用所选模型', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'))
    expect(policies).toContain('foundation-model/deepseek.v3.2')
    expect(policies).not.toMatch(/"Action":"bedrock:\*"/)
  })

  it('ws-rewrite：ARN 占位符替换为 Runtime ARN', () => {
    const fns = Object.values(t.findResources('AWS::CloudFront::Function')).map((r) => JSON.stringify(r.Properties.FunctionCode))
    const ws = fns.find((c) => c.includes('/ws'))
    expect(ws).toBeDefined()
    expect(ws).not.toContain('__RUNTIME_ARN__')
    expect(ws).toContain('AgentRuntimeArn')
  })

  it('分发：默认不缓存；/api/remote.mux 只允许 GET/HEAD；/plugins/* 可缓存且删除 Set-Cookie', () => {
    const dist = one(t, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as {
      DefaultCacheBehavior: { CachePolicyId: string; FunctionAssociations: unknown[] }
      CacheBehaviors: { PathPattern: string; AllowedMethods: string[]; ResponseHeadersPolicyId?: unknown; FunctionAssociations: unknown[] }[]
      CustomErrorResponses: { ErrorCode: number; ErrorCachingMinTTL: number }[]
    }
    expect(dist.DefaultCacheBehavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad') // CachingDisabled
    const ws = dist.CacheBehaviors.find((b) => b.PathPattern === '/api/remote.mux')
    const plugins = dist.CacheBehaviors.find((b) => b.PathPattern === '/plugins/*')
    expect(ws?.AllowedMethods).toEqual(['GET', 'HEAD'])
    expect(plugins?.ResponseHeadersPolicyId).toBeDefined()
    expect(dist.CustomErrorResponses.every((e) => e.ErrorCachingMinTTL === 0)).toBe(true)
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({ RemoveHeadersConfig: { Items: [{ Header: 'Set-Cookie' }] } }),
    })
    t.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({ HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['x-dsh-raw-query'] } }) }),
    })
  })

  it('隧道 Lambda：响应流 Function URL；源站密钥用动态引用，不以明文出现在模板里', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' })
    const env = JSON.stringify(t.findResources('AWS::Lambda::Function'))
    expect(env).toContain('{{resolve:secretsmanager:')
  })

  it('用户口令不经过模板：自定义资源只带 Secret ARN', () => {
    const users = Object.values(t.findResources('Custom::DshPocUser'))
    expect(users.map((u) => (u as { Properties: { Username: string } }).Properties.Username).sort()).toEqual(['demo', 'ops'])
    expect(JSON.stringify(users)).not.toContain('resolve:secretsmanager')
  })

  it('mockModel=true：容器使用模拟模型，执行角色没有模型权限', () => {
    const m = synth({ mockModel: 'true' })
    expect(JSON.stringify(one(m, 'AWS::BedrockAgentCore::Runtime').Properties.EnvironmentVariables)).toContain('MOCK_MODEL')
    expect(JSON.stringify(m.findResources('AWS::IAM::Policy'))).not.toContain('bedrock:InvokeModel')
  })
})

describe('deploy 数据清空保护：cdk diff 中的 Runtime 变更', () => {
  it('识别 [~] 与 [-]，忽略 [+] 与其他资源', () => {
    expect(runtimeChanged('Resources\n[~] AWS::BedrockAgentCore::Runtime Agent/Runtime AgentRuntime291C25AF\n')).toBe(true)
    expect(runtimeChanged('\x1b[33m[~]\x1b[39m AWS::BedrockAgentCore::Runtime Agent/Runtime X')).toBe(true)
    expect(runtimeChanged('[-] AWS::BedrockAgentCore::Runtime Old destroy\n[+] AWS::BedrockAgentCore::Runtime New')).toBe(true)
    expect(runtimeChanged('[+] AWS::BedrockAgentCore::Runtime Agent/Runtime X')).toBe(false)
    expect(runtimeChanged('[~] AWS::Lambda::Function Tunnel/Fn X\n There were no differences')).toBe(false)
    expect(runtimeChanged('Stack DshPoc\nThere were no differences')).toBe(false)
  })
})

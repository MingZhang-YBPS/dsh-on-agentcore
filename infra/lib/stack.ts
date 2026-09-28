// 单一 Stack：Auth → Runtime → Tunnel → Edge → Observability。

import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { AuthConstruct } from './auth.js'
import { EdgeConstruct } from './edge.js'
import { ObservabilityConstruct } from './observability.js'
import { readParams } from './params.js'
import { RuntimeConstruct } from './runtime.js'
import { TunnelConstruct } from './tunnel.js'

export const STACK_NAME = 'DshPoc'

export class DshPocStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)
    const p = readParams(this.node, this.region)
    const auth = new AuthConstruct(this, 'Auth', p)
    const rt = new RuntimeConstruct(this, 'Agent', p, auth)
    const tunnel = new TunnelConstruct(this, 'Tunnel', p, auth, rt)
    const edge = new EdgeConstruct(this, 'Edge', tunnel, rt)
    new ObservabilityConstruct(this, 'Observability', p, rt, tunnel, edge.distribution)

    // Spike 08：Runtime 的标签变更也会清空数据，所以标签只打在其他资源上（Stack 级标签会继承到 Runtime，这里不用）
    for (const c of [auth, tunnel, edge]) Tags.of(c).add('project', 'dsh-poc')

    const out = (id: string, value: string, description: string) => new CfnOutput(this, id, { value, description })
    out('WebUrl', `https://${edge.distribution.distributionDomainName}/`, 'DSH Web UI entry point')
    out('DistributionId', edge.distribution.distributionId, 'CloudFront distribution ID')
    out('AgentRuntimeArn', rt.runtime.attrAgentRuntimeArn, 'AgentCore Runtime ARN')
    out('AgentRuntimeId', rt.runtime.attrAgentRuntimeId, 'AgentCore Runtime ID')
    out('AgentRuntimeVersion', rt.runtime.attrAgentRuntimeVersion, 'AgentCore Runtime version (changes => all session storage is wiped)')
    out('EffectiveModelId', p.modelId, 'Model ID used by DSH')
    out('EffectiveModelRegion', p.modelRegion, 'Model region')
    out('EffectiveModelEndpointSurface', p.modelEndpointSurface, 'bedrock-runtime or bedrock-mantle')
    out('MockModel', String(p.mockModel), 'true => the container uses the mock model upstream')
    out('DeepSeekApiKeySecretArn', rt.deepseekKey.secretArn, 'Secrets Manager ARN holding the DeepSeek API key for web search (set it with DEEPSEEK_API_KEY=... npm run deploy)')
    out('UserPoolId', auth.pool.userPoolId, 'Cognito user pool ID')
    out('UserPoolClientId', auth.client.userPoolClientId, 'Cognito app client ID')
    out('TunnelFunctionName', tunnel.fn.functionName, 'Tunnel Lambda function name')
    for (const [name, secret] of Object.entries(auth.userSecrets)) {
      out(`UserSecret${name.replace(/[^A-Za-z0-9]/g, '')}`, secret.secretArn, `Secrets Manager ARN holding the password of user ${name}`)
    }
  }
}

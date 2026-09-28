// RuntimeConstruct：代码包资产 + 最小权限执行角色 + DeepSeek API key 的 secret + AWS::BedrockAgentCore::Runtime（L1）。
// 注意（Spike 08）：Runtime 的任何属性变更都会产生新版本并清空全部用户的 session storage。
// 因此这里不放任何随部署变化的值；代码包是可重复构建的（build-adapter.sh），输入不变时资产哈希不变。

import { Aws, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { existsSync } from 'node:fs'
import { surfaceBase, surfaceService, type Params } from './params.js'
import type { AuthConstruct } from './auth.js'

export const MOUNT_PATH = '/mnt/workspace'
export const RUNTIME_NAME = 'dsh_poc_web'

export class RuntimeConstruct extends Construct {
  readonly runtime: agentcore.CfnRuntime
  readonly role: iam.Role
  /** DeepSeek（api.deepseek.com）API key，供网页搜索使用；值由 deploy 包装器写入（DEEPSEEK_API_KEY），模板里只有占位值 */
  readonly deepseekKey: secrets.Secret

  constructor(scope: Construct, id: string, p: Params, auth: AuthConstruct) {
    super(scope, id)
    if (!existsSync(p.adapterZip)) throw new Error(`adapter package not found: ${p.adapterZip} (run npm run build:adapter)`)
    const code = new s3assets.Asset(this, 'AdapterCode', { path: p.adapterZip })
    const region = Stack.of(this).region

    this.role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID }, ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` } },
      }),
      description: 'DSH PoC AgentCore Runtime execution role: model invocation and logs only (no user data access)',
    })
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'Logs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }))
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'WorkloadToken',
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: [`arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default`, `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`],
    }))
    this.role.addToPolicy(new iam.PolicyStatement({ sid: 'XRay', actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] }))
    // 模型权限（Spike 07 实测）：bedrock-runtime 端点面只需 bedrock:InvokeModel（流式同样如此），资源限定到所选基础模型；
    // bedrock-mantle 端点面需要 bedrock-mantle:CreateInference，只能按项目授权
    if (!p.mockModel) {
      this.role.addToPolicy(p.modelEndpointSurface === 'bedrock-runtime'
        ? new iam.PolicyStatement({ sid: 'InvokeModel', actions: ['bedrock:InvokeModel'], resources: [`arn:${Aws.PARTITION}:bedrock:${p.modelRegion}::foundation-model/${p.modelId}`] })
        : new iam.PolicyStatement({ sid: 'MantleInference', actions: ['bedrock-mantle:CreateInference'], resources: [`arn:${Aws.PARTITION}:bedrock-mantle:${p.modelRegion}:${Aws.ACCOUNT_ID}:project/default`] }))
    }
    code.grantRead(this.role)
    // 占位值只在创建时写入；之后由 deploy 包装器 PutSecretValue，模板不变，所以更新 key 不会改动 Runtime（不清空数据）
    this.deepseekKey = new secrets.Secret(this, 'DeepSeekApiKey', {
      description: 'DSH PoC: DeepSeek (api.deepseek.com) API key used by web search; "not-configured" means unset',
      secretStringValue: SecretValue.unsafePlainText('not-configured'),
      removalPolicy: RemovalPolicy.DESTROY,
    })
    this.deepseekKey.grantRead(this.role)

    const env: Record<string, string> = {
      MODEL_ID: p.modelId,
      MODEL_REGION: p.modelRegion,
      MODEL_BASE_URL: surfaceBase(p.modelEndpointSurface, p.modelRegion),
      MODEL_SIGNING_SERVICE: surfaceService(p.modelEndpointSurface),
      USER_HOME: MOUNT_PATH,
      REQUIRE_SESSION_OWNER: '1',
      WS_KEEPALIVE_MS: String(p.wsKeepaliveMs),
      WS_FRAME_MAX: String(p.wsFrameMax),
      DSH_HOME_MIRROR_MS: String(p.homeMirrorIntervalMs),
      DSH_READY_TIMEOUT_MS: String(p.dshReadyTimeoutMs),
      DEEPSEEK_KEY_SECRET_ARN: this.deepseekKey.secretArn,
      ...(p.mockModel ? { MOCK_MODEL: '1' } : {}),
    }
    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: RUNTIME_NAME,
      description: 'DSH PoC: official DSH Web UI, one runtime session per user',
      roleArn: this.role.roleArn,
      agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, runtime: 'NODE_22', entryPoint: ['app.js'] } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: env,
      filesystemConfigurations: [{ sessionStorage: { mountPath: MOUNT_PATH } }],
      // /ws 上 AgentCore 只转发写成 Authorization 的头（Spike 06 C15）
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      // Cognito 访问令牌没有 aud 声明，只有 client_id：用 allowedClients
      authorizerConfiguration: { customJwtAuthorizer: { discoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${auth.pool.userPoolId}/.well-known/openid-configuration`, allowedClients: [auth.client.userPoolClientId] } },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: p.idleRuntimeSessionTimeoutSeconds, maxLifetime: p.maxLifetimeSeconds },
    })
    // 执行角色的策略必须先于 Runtime 就绪（Runtime 创建时会校验代码包读取权限）
    this.runtime.node.addDependency(this.role)
  }
}

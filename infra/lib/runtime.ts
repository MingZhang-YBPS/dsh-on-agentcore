// RuntimeConstruct：代码包资产 + 最小权限执行角色 + DeepSeek API key 的 secret + AWS::BedrockAgentCore::Runtime（L1）。
// 注意（Spike 08）：Runtime 的任何属性变更都会产生新版本并清空全部用户的 session storage。
// 因此这里不放任何随部署变化的值；代码包是可重复构建的（build-adapter.sh），输入不变时资产哈希不变。
// 执行角色、环境变量、JWT 授权器的构造函数也供每用户 Runtime 部署（per-user-stack.ts）复用。

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

/** 适配器代码包资产（build-adapter.sh 的输出） */
export function adapterCode(scope: Construct, id: string, p: Params, zip = p.adapterZip): s3assets.Asset {
  if (!existsSync(zip)) throw new Error(`adapter package not found: ${zip} (run npm run build:adapter)`)
  return new s3assets.Asset(scope, id, { path: zip })
}

/** DeepSeek API key 的 secret：占位值只在创建时写入；之后由 deploy 包装器 PutSecretValue，模板不变 */
export function deepseekKeySecret(scope: Construct, id: string, description = 'DSH PoC: DeepSeek (api.deepseek.com) API key used by web search; "not-configured" means unset'): secrets.Secret {
  return new secrets.Secret(scope, id, {
    description,
    secretStringValue: SecretValue.unsafePlainText('not-configured'),
    removalPolicy: RemovalPolicy.DESTROY,
  })
}

/** 最小权限执行角色：日志、工作负载令牌、X-Ray、所选模型；不含任何用户数据权限 */
export function executionRole(scope: Construct, id: string, p: Params, description: string): iam.Role {
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID }, ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` } },
    }),
    description,
  })
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'Logs',
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
    resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`],
  }))
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'WorkloadToken',
    actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
    resources: [`arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default`, `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`],
  }))
  role.addToPolicy(new iam.PolicyStatement({ sid: 'XRay', actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] }))
  // 模型权限（Spike 07 实测）：bedrock-runtime 端点面只需 bedrock:InvokeModel（流式同样如此），资源限定到所选基础模型；
  // bedrock-mantle 端点面需要 bedrock-mantle:CreateInference，只能按项目授权
  if (!p.mockModel) {
    role.addToPolicy(p.modelEndpointSurface === 'bedrock-runtime'
      ? new iam.PolicyStatement({ sid: 'InvokeModel', actions: ['bedrock:InvokeModel'], resources: [`arn:${Aws.PARTITION}:bedrock:${p.modelRegion}::foundation-model/${p.modelId}`] })
      : new iam.PolicyStatement({ sid: 'MantleInference', actions: ['bedrock-mantle:CreateInference'], resources: [`arn:${Aws.PARTITION}:bedrock-mantle:${p.modelRegion}:${Aws.ACCOUNT_ID}:project/default`] }))
  }
  return role
}

/** 适配器的环境变量（与 Runtime 无关的部分） */
export function adapterEnv(p: Params, deepseekKeySecretArn: string): Record<string, string> {
  return {
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
    DEEPSEEK_KEY_SECRET_ARN: deepseekKeySecretArn,
    ...(p.mockModel ? { MOCK_MODEL: '1' } : {}),
  }
}

/** Cognito 访问令牌没有 aud 声明，只有 client_id：用 allowedClients；customClaims 用于把 Runtime 限定给单个用户 */
export function jwtAuthorizer(scope: Construct, auth: AuthConstruct, customClaims?: agentcore.CfnRuntime.CustomClaimValidationTypeProperty[]): agentcore.CfnRuntime.AuthorizerConfigurationProperty {
  const region = Stack.of(scope).region
  return {
    customJwtAuthorizer: {
      discoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${auth.pool.userPoolId}/.well-known/openid-configuration`,
      allowedClients: [auth.client.userPoolClientId],
      ...(customClaims ? { customClaims } : {}),
    },
  }
}

export class RuntimeConstruct extends Construct {
  readonly runtime: agentcore.CfnRuntime
  readonly role: iam.Role
  /** DeepSeek（api.deepseek.com）API key，供网页搜索使用；值由 deploy 包装器写入（DEEPSEEK_API_KEY），模板里只有占位值 */
  readonly deepseekKey: secrets.Secret

  constructor(scope: Construct, id: string, p: Params, auth: AuthConstruct) {
    super(scope, id)
    const code = adapterCode(this, 'AdapterCode', p)
    this.role = executionRole(this, 'ExecutionRole', p, 'DSH PoC AgentCore Runtime execution role: model invocation and logs only (no user data access)')
    code.grantRead(this.role)
    this.deepseekKey = deepseekKeySecret(this, 'DeepSeekApiKey')
    this.deepseekKey.grantRead(this.role)

    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: RUNTIME_NAME,
      description: 'DSH PoC: official DSH Web UI, one runtime session per user',
      roleArn: this.role.roleArn,
      agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, runtime: 'NODE_22', entryPoint: ['app.js'] } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: adapterEnv(p, this.deepseekKey.secretArn),
      filesystemConfigurations: [{ sessionStorage: { mountPath: MOUNT_PATH } }],
      // /ws 上 AgentCore 只转发写成 Authorization 的头（Spike 06 C15）
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      authorizerConfiguration: jwtAuthorizer(this, auth),
      lifecycleConfiguration: { idleRuntimeSessionTimeout: p.idleRuntimeSessionTimeoutSeconds, maxLifetime: p.maxLifetimeSeconds },
    })
    // 执行角色的策略必须先于 Runtime 就绪（Runtime 创建时会校验代码包读取权限）
    this.runtime.node.addDependency(this.role)
  }
}

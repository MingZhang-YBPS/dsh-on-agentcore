// TunnelConstruct：隧道 Lambda（Node.js 22 arm64，响应流）+ Function URL（AuthType NONE，由源站密钥头挡住直连）+ 源站密钥。

import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { AuthConstruct } from './auth.js'
import { bundleTunnel } from './bundle.js'
import type { Params } from './params.js'

export class TunnelConstruct extends Construct {
  readonly fn: lambda.Function
  readonly url: lambda.FunctionUrl
  readonly logGroup: logs.LogGroup
  readonly originSecret: secrets.Secret

  /**
   * runtimeEnv：共享 Runtime 时为 { RUNTIME_ARN }（入口 services/tunnel/src/index.ts）；
   * 每用户 Runtime 时为 { RUNTIME_ARN_PREFIX, USER_RUNTIMES }（入口 per-user.ts，opts.entry 指定）
   */
  constructor(scope: Construct, id: string, p: Params, auth: AuthConstruct, runtimeEnv: Record<string, string>, opts: { entry?: 'index.ts' | 'per-user.ts'; description?: string } = {}) {
    super(scope, id)
    this.originSecret = new secrets.Secret(this, 'OriginSecret', {
      description: 'DSH PoC: X-Origin-Verify header value shared by CloudFront and the tunnel Lambda',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    })
    this.logGroup = new logs.LogGroup(this, 'Logs', { retention: retentionOf(p.logRetentionDays), removalPolicy: RemovalPolicy.DESTROY })
    this.fn = new lambda.Function(this, 'Fn', {
      description: opts.description ?? 'DSH PoC tunnel: login, cookie token, envelope + InvokeAgentRuntime streaming',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(bundleTunnel(opts.entry)),
      timeout: Duration.seconds(900),
      memorySize: 512,
      logGroup: this.logGroup,
      environment: {
        ...runtimeEnv,
        USER_POOL_ID: auth.pool.userPoolId,
        CLIENT_ID: auth.client.userPoolClientId,
        // CloudFormation 动态引用，部署时解析，不出现在模板里
        ORIGIN_SECRET: this.originSecret.secretValue.unsafeUnwrap(),
        THROTTLE_TABLE: auth.throttleTable.tableName,
        REFRESH_TOKEN_VALIDITY_DAYS: String(p.refreshTokenValidityDays),
        TOKEN_REFRESH_SKEW_SECONDS: String(p.tokenRefreshSkewSeconds),
        LOG_LEVEL: 'info',
      },
    })
    // 调用 AgentCore 用的是用户的 Bearer 令牌（JWT 授权器），Lambda 角色不需要 bedrock-agentcore 权限
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'Cognito', actions: ['cognito-idp:AdminInitiateAuth', 'cognito-idp:AdminUserGlobalSignOut'], resources: [auth.pool.userPoolArn] }))
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'Throttle', actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [auth.throttleTable.tableArn] }))
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM })
  }
}

export function retentionOf(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === 'number')
  if (!allowed.includes(days)) throw new Error(`logRetentionDays must be one of ${allowed.join(', ')}`)
  return days as logs.RetentionDays
}

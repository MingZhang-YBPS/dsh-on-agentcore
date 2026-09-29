// 每用户 Runtime + EFS 部署（设计决策点 D4 方案 A）：独立的栈 DshPerUser，与已部署的 DshPoc 互不影响
// （资源名称、Runtime 名称、日志组前缀都不同，可以同时存在于同一账号区域）。
//   主栈：Auth（独立的用户池，不含 ops）→ Network（VPC + NAT）→ 共享的代码包、DeepSeek key、路由表与两个自定义资源 Provider
//        → Tunnel（查路由表选 Runtime，并下发 dsh_rt cookie）→ Edge（ws-rewrite-per-user 读 dsh_rt）→ Observability
//   每名用户一个嵌套栈 User-<用户名>（user-stack.ts）：Cognito 用户、EFS、Runtime、路由项
// 主栈里每名用户只有一个资源（嵌套栈）、没有输出，用户数只受 AgentCore Runtime 配额（默认每账号区域 1000）限制。
// Runtime 变更不再清空数据：数据在各用户的 EFS 上；只有删除 EFS 文件系统（删除用户、卸载）才会删除数据。

import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cr from 'aws-cdk-lib/custom-resources'
import type { Construct } from 'constructs'
import { join } from 'node:path'
import { AuthConstruct } from './auth.js'
import { REPO_ROOT } from './bundle.js'
import { EdgeConstruct, wsRewritePerUserCode } from './edge.js'
import { NetworkConstruct } from './network.js'
import { ObservabilityConstruct } from './observability.js'
import { readParams, readPerUserParams, userRuntimeName } from './params.js'
import { adapterCode, deepseekKeySecret } from './runtime.js'
import { TunnelConstruct } from './tunnel.js'
import { UserRuntimeConstruct } from './user-runtime.js'
import { LOGIN_SECRET_TAG, UserStack } from './user-stack.js'

export const PER_USER_STACK_NAME = 'DshPerUser'
/** 面板里的日志查询最多引用 50 个日志组（Logs Insights 上限） */
const DASHBOARD_MAX_RUNTIMES = 50

export class DshPerUserStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)
    const p = readParams(this.node, this.region)
    const pu = readPerUserParams(this.node, this.region, p)

    // 用户都在嵌套栈里创建；没有 ops 用户（各 Runtime 的授权器只接受其所属用户的令牌，ops 调不了任何 Runtime）
    const auth = new AuthConstruct(this, 'Auth', p, [])
    // provisioner 凭标签读取口令 secret（逐个 ARN 授权会让它的内联策略随用户数增长，超过 10 KB 上限）
    auth.provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadLoginSecrets',
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [`arn:${Aws.PARTITION}:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:*`],
      conditions: { StringEquals: { [`aws:ResourceTag/${LOGIN_SECRET_TAG}`]: this.stackName } },
    }))
    const net = new NetworkConstruct(this, 'Network', pu)
    // 每用户 Runtime 的代码包带 per-user-entry.js：等 EFS 挂载出现后再启动适配器（AgentCore 先启动进程、后挂载 EFS）
    const code = adapterCode(this, 'AdapterCode', p, pu.adapterZip)
    const deepseekKey = deepseekKeySecret(this, 'DeepSeekApiKey')

    // 路由表：pk = USER#<用户名>，runtimeId。由各嵌套栈里的 Custom::DshPerUserRoute 写入（Runtime 被替换后 ID 随之更新），删除用户时删除
    const routes = new dynamodb.Table(this, 'RouteTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    const routeFn = new lambda.Function(this, 'UserRouteFn', {
      description: 'DSH per-user: write the user -> runtime route and set the runtime log group retention',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(join(REPO_ROOT, 'infra', 'lambda', 'user-route')),
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'UserRouteFnLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    })
    routeFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'Routes', actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'], resources: [routes.tableArn] }))
    routeFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RuntimeLogGroups',
      actions: ['logs:CreateLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteLogGroup'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/${userRuntimeName('')}*`],
    }))
    const routeProvider = new cr.Provider(this, 'UserRouteProvider', {
      onEventHandler: routeFn,
      logGroup: new logs.LogGroup(this, 'UserRouteProviderLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    })

    const users: Record<string, UserStack> = {}
    for (const user of p.demoUsers) {
      users[user] = new UserStack(this, `User-${user}`, { user, p, pu, auth, net, code, deepseekKey, parentStackName: this.stackName, routeProvider, routeTableName: routes.tableName })
    }

    const arnPrefix = UserRuntimeConstruct.arnPrefix()
    const tunnel = new TunnelConstruct(this, 'Tunnel', p, auth,
      { RUNTIME_ARN_PREFIX: arnPrefix, ROUTE_TABLE: routes.tableName },
      { entry: 'per-user.ts', description: 'DSH per-user tunnel: login, cookie token, envelope + InvokeAgentRuntime streaming to the caller\'s own runtime' })
    tunnel.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'Routes', actions: ['dynamodb:GetItem'], resources: [routes.tableArn] }))
    const edge = new EdgeConstruct(this, 'Edge', tunnel, wsRewritePerUserCode(arnPrefix), {
      wsComment: 'DSH per-user: /api/remote.mux -> the caller\'s AgentCore runtime /ws with Bearer token from cookie',
      comment: 'DSH per-user (official DSH Web UI, one AgentCore Runtime + EFS per user)',
    })
    // 面板只放前 50 名用户的 Runtime 日志（每个都会在嵌套栈上产生一个输出）；保留期由各嵌套栈设置
    const dashboardRuntimes = Object.fromEntries(Object.entries(users).slice(0, DASHBOARD_MAX_RUNTIMES).map(([u, s]) => [u, s.user.runtime.attrAgentRuntimeId]))
    new ObservabilityConstruct(this, 'Observability', p, dashboardRuntimes, tunnel, edge.distribution, false)

    Tags.of(this).add('project', 'dsh-per-user')

    // 每名用户的输出（口令 secret、Runtime ARN、EFS ID）在各自的嵌套栈上；deploy 包装器部署完成后汇总打印
    const out = (id: string, value: string, description: string) => new CfnOutput(this, id, { value, description })
    out('WebUrl', `https://${edge.distribution.distributionDomainName}/`, 'DSH Web UI entry point')
    out('DistributionId', edge.distribution.distributionId, 'CloudFront distribution ID')
    out('VpcId', net.vpc.ref, 'VPC of the per-user runtimes and EFS mount targets')
    out('RouteTableName', routes.tableName, 'DynamoDB table: USER#<username> -> runtimeId, read by the tunnel Lambda')
    out('EffectiveModelId', p.modelId, 'Model ID used by DSH')
    out('EffectiveModelRegion', p.modelRegion, 'Model region')
    out('EffectiveModelEndpointSurface', p.modelEndpointSurface, 'bedrock-runtime or bedrock-mantle')
    out('MockModel', String(p.mockModel), 'true => the container uses the mock model upstream')
    out('DeepSeekApiKeySecretArn', deepseekKey.secretArn, 'Shared DeepSeek API key secret, used by users not listed in deepseekSecretPerUser (set it with DEEPSEEK_API_KEY=... npm run deploy:per-user)')
    out('UserPoolId', auth.pool.userPoolId, 'Cognito user pool ID')
    out('UserPoolClientId', auth.client.userPoolClientId, 'Cognito app client ID')
    out('TunnelFunctionName', tunnel.fn.functionName, 'Tunnel Lambda function name')
  }
}

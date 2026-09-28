// 最小 CDK 应用：Cognito User Pool + 执行角色 + AWS::BedrockAgentCore::Runtime（L1 CfnRuntime）。
// Runtime 配置与正式设计一致：NODE_22 直接代码部署、session storage、requestHeaderAllowlist=Authorization、customJWTAuthorizer。
// 通过 context 改变单个属性，用于观察「哪些变更会产生新的 Runtime 版本、是否清空 session storage」：
//   -c stack=<名称>       栈名（默认 DshPocSpike08），同时决定 Runtime 名称后缀
//   -c mark=<值>          环境变量 MARK
//   -c desc=<值>          Description
//   -c tagv=<值>          标签 rev 的值
//   -c idle=<秒>          lifecycleConfiguration.idleRuntimeSessionTimeout
//   -c fail=bucket        额外创建一个必然失败的资源（信任策略主体不存在，IAM 创建时失败），依赖于 Runtime，因而在 Runtime 之后执行
// 代码包目录由环境变量 AGENT_DIR 指定（默认 ./agent），驱动脚本通过改写其中的 CODE_REV 来制造「只改代码」的变更。
import { App, Stack, CfnOutput, RemovalPolicy, Aws } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

const app = new App()
const ctx = (k, d) => app.node.tryGetContext(k) ?? d
const stackName = ctx('stack', 'DshPocSpike08')
const stack = new Stack(app, stackName, { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }, tags: { purpose: 'dsh-poc-spike-08' } })

const pool = new cognito.UserPool(stack, 'Pool', { selfSignUpEnabled: false, removalPolicy: RemovalPolicy.DESTROY, signInCaseSensitive: false })
const client = pool.addClient('Client', { authFlows: { adminUserPassword: true }, generateSecret: false, preventUserExistenceErrors: true })

const code = new s3assets.Asset(stack, 'Code', { path: process.env.AGENT_DIR ?? './agent' })
const role = new iam.Role(stack, 'ExecRole', {
  assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
    conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID }, ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` } },
  }),
})
role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'], resources: [`arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*`] }))
role.addToPolicy(new iam.PolicyStatement({
  actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
  resources: [`arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default`, `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`],
}))
code.grantRead(role)

const runtime = new agentcore.CfnRuntime(stack, 'Runtime', {
  agentRuntimeName: `dsh_poc_spike_08_${stackName.replace(/[^A-Za-z0-9]/g, '').slice(-12).toLowerCase()}`,
  roleArn: role.roleArn,
  description: ctx('desc', 'spike08 probe'),
  agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, runtime: 'NODE_22', entryPoint: ['app.js'] } },
  networkConfiguration: { networkMode: 'PUBLIC' },
  protocolConfiguration: 'HTTP',
  environmentVariables: { MARK: String(ctx('mark', '1')), MOUNT_PATH: '/mnt/workspace' },
  filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
  requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
  authorizerConfiguration: { customJwtAuthorizer: { discoveryUrl: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`, allowedClients: [client.userPoolClientId] } },
  lifecycleConfiguration: { idleRuntimeSessionTimeout: Number(ctx('idle', 900)), maxLifetime: 3600 },
  tags: { purpose: 'dsh-poc-spike-08', rev: String(ctx('tagv', 'a')) },
})
runtime.node.addDependency(role)

if (ctx('fail', '') === 'bucket') {
  // 必然在「执行阶段」失败的资源：信任策略里的主体不存在，IAM 在 CreateRole 时返回 MalformedPolicyDocument。
  // （与现有桶同名的 S3 桶会被 CloudFormation 的部署前校验直接拦下，变更集根本不执行，Spike 08 第一轮实测）
  const failing = new iam.CfnRole(stack, 'MustFail', {
    assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::000000000000:role/spike08-does-not-exist' }, Action: 'sts:AssumeRole' }] },
  })
  failing.addDependency(runtime)
}

new CfnOutput(stack, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn })
new CfnOutput(stack, 'RuntimeId', { value: runtime.attrAgentRuntimeId })
new CfnOutput(stack, 'RuntimeVersion', { value: runtime.attrAgentRuntimeVersion })
new CfnOutput(stack, 'PoolId', { value: pool.userPoolId })
new CfnOutput(stack, 'ClientId', { value: client.userPoolClientId })

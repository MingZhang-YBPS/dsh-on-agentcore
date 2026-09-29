// UserStack（DshPerUser 的嵌套栈）：一名用户的全部资源——Cognito 用户与口令 secret、执行角色、EFS（文件系统、挂载目标、访问点）、
// AgentCore Runtime、路由项与 Runtime 日志组保留期。
// 为什么用嵌套栈：CloudFormation 单栈最多 500 个资源、200 个输出，每名用户约 11 个资源、5 个输出，单栈只能放下约 37 名用户；
// 放进嵌套栈后主栈里每名用户只剩一个 AWS::CloudFormation::Stack 资源，用户数的上限变成 AgentCore Runtime 配额（默认 1000）。
// 删除这个嵌套栈（从 demoUsers 去掉用户）会删除该用户的 EFS 文件系统，即删除该用户的全部数据；deploy 包装器会拦下这种变更。

import { CfnOutput, CustomResource, NestedStack, Tags } from 'aws-cdk-lib'
import type * as cr from 'aws-cdk-lib/custom-resources'
import type { Construct } from 'constructs'
import { userDeepSeekKeyEnv, userRuntimeName } from './params.js'
import { deepseekKeySecret } from './runtime.js'
import { UserRuntimeConstruct, type UserRuntimeProps } from './user-runtime.js'

/** 口令 secret 上的标签：主栈的 provisioner 凭它（而不是逐个 ARN）读取口令 */
export const LOGIN_SECRET_TAG = 'dsh-login-secret'

export const runtimeLogGroupName = (runtimeId: string): string => `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`

export interface UserStackProps extends UserRuntimeProps {
  /** 主栈名称（口令 secret 标签的值） */
  parentStackName: string
  routeProvider: cr.Provider
  routeTableName: string
}

export class UserStack extends NestedStack {
  readonly user: UserRuntimeConstruct

  constructor(scope: Construct, id: string, props: UserStackProps) {
    super(scope, id, { description: `DSH per-user resources of ${props.user} (Cognito user, EFS, AgentCore Runtime)` })
    const { user, auth, p } = props
    const secret = auth.addUser(this, user, false)
    Tags.of(secret).add(LOGIN_SECRET_TAG, props.parentStackName)

    // DeepSeek key：列在 deepseekSecretPerUser 中的用户用自己的 secret（执行角色只能读它），其余用户用主栈的共享 secret
    const ownKey = props.pu.deepseekSecretPerUser.includes(user)
    const deepseekKey = ownKey
      ? deepseekKeySecret(this, 'DeepSeekApiKey', `DSH per-user: DeepSeek (api.deepseek.com) API key of ${user}; "not-configured" means unset (set it with ${userDeepSeekKeyEnv(user)}=... npm run deploy:per-user)`)
      : props.deepseekKey
    this.user = new UserRuntimeConstruct(this, 'Agent', { ...props, deepseekKey })
    const runtimeId = this.user.runtime.attrAgentRuntimeId
    new CustomResource(this, 'Route', {
      serviceToken: props.routeProvider.serviceToken,
      resourceType: 'Custom::DshPerUserRoute',
      properties: { TableName: props.routeTableName, Username: user, RuntimeId: runtimeId, LogGroupName: runtimeLogGroupName(runtimeId), RetentionDays: String(p.logRetentionDays) },
    })

    // 这些输出在嵌套栈上（不占主栈的 200 个输出）；deploy 包装器部署完成后汇总打印
    const out = (k: string, value: string, description: string) => new CfnOutput(this, k, { value, description })
    out('Username', user, 'Cognito user name')
    out('UserSecretArn', secret.secretArn, `Secrets Manager ARN holding the password of user ${user}`)
    out('RuntimeName', userRuntimeName(user), 'AgentCore Runtime name')
    out('AgentRuntimeArn', this.user.runtime.attrAgentRuntimeArn, 'AgentCore Runtime ARN')
    out('AgentRuntimeVersion', this.user.runtime.attrAgentRuntimeVersion, 'AgentCore Runtime version (a new version does NOT wipe data: it is on EFS)')
    out('EfsFileSystemId', this.user.fileSystem.ref, 'EFS file system holding all data of this user')
    out('DeepSeekKeyScope', ownKey ? 'user' : 'shared', 'user: this user has its own DeepSeek key secret; shared: the stack-wide secret')
    out('DeepSeekApiKeySecretArn', deepseekKey.secretArn, 'Secrets Manager ARN of the DeepSeek API key this user\'s runtime reads')
  }
}

// UserRuntimeConstruct（每用户 Runtime 部署）：一名用户独占的 EFS 文件系统 + 挂载目标 + 访问点 + 执行角色 + AgentCore Runtime。
// 与共享 Runtime（runtime.ts）的区别：
//   - 数据在该用户自己的 EFS 上（挂载到 /mnt/workspace），与 Runtime 版本无关：升级适配器、改环境变量都不再清空数据；
//     EFS 支持硬链接，DSH_HOME 直接放在 EFS 上，不再镜像（DSH_HOME_MIRROR=0）
//   - JWT 授权器除 client_id 外还要求 username 声明等于该用户，其他用户（包括 ops）的令牌调用不了这个 Runtime
//   - 执行角色只能以该用户的访问点挂载该用户的文件系统；文件系统策略只允许这个角色、只允许 TLS
// 删除用户（从 demoUsers 去掉）会删除其 Runtime、访问点与文件系统，即删除该用户的全部数据。

import { Aws, RemovalPolicy } from 'aws-cdk-lib'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import type * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { AuthConstruct } from './auth.js'
import type { NetworkConstruct } from './network.js'
import { userRuntimeName, type Params, type PerUserParams } from './params.js'
import { MOUNT_PATH, adapterEnv, executionRole, jwtAuthorizer } from './runtime.js'

export interface UserRuntimeProps {
  user: string
  p: Params
  pu: PerUserParams
  auth: AuthConstruct
  net: NetworkConstruct
  code: s3assets.Asset
  deepseekKey: secrets.ISecret
}

export class UserRuntimeConstruct extends Construct {
  readonly runtime: agentcore.CfnRuntime
  readonly role: iam.Role
  readonly fileSystem: efs.CfnFileSystem
  readonly accessPoint: efs.CfnAccessPoint

  constructor(scope: Construct, id: string, { user, p, pu, auth, net, code, deepseekKey }: UserRuntimeProps) {
    super(scope, id)
    this.role = executionRole(this, 'ExecutionRole', p, `DSH per-user AgentCore Runtime execution role for ${user}: model, logs and this user's EFS access point only`)
    code.grantRead(this.role)
    deepseekKey.grantRead(this.role)

    this.fileSystem = new efs.CfnFileSystem(this, 'FileSystem', {
      encrypted: true,
      performanceMode: 'generalPurpose',
      throughputMode: 'elastic',
      lifecyclePolicies: [{ transitionToIa: 'AFTER_30_DAYS' }, { transitionToPrimaryStorageClass: 'AFTER_1_ACCESS' }],
      backupPolicy: { status: pu.efsBackup ? 'ENABLED' : 'DISABLED' },
      fileSystemTags: [{ key: 'Name', value: `dsh-per-user-${user}` }, { key: 'dsh-user', value: user }],
      // 只允许该用户的执行角色经挂载目标、以 TLS 挂载；没有匿名（非 IAM）NFS 客户端的放行，也不授予 ClientRootAccess
      fileSystemPolicy: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'UserRuntimeOnly',
          Effect: 'Allow',
          // 用「本账号 + aws:PrincipalArn 条件」而不是直接写角色 ARN：新建角色在 IAM 中传播前，EFS 可能把它判为无效主体
          Principal: { AWS: `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:root` },
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Condition: {
            ArnEquals: { 'aws:PrincipalArn': this.role.roleArn },
            Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true', 'aws:SecureTransport': 'true' },
          },
        }],
      },
    })
    this.fileSystem.applyRemovalPolicy(RemovalPolicy.DESTROY)
    const mountTargets = net.privateSubnets.map((s, i) => new efs.CfnMountTarget(this, `MountTarget${i + 1}`, { fileSystemId: this.fileSystem.ref, subnetId: s.ref, securityGroups: [net.efsSg.attrGroupId] }))

    // 所有文件操作都以 posixUser 执行；根目录首次挂载时按 creationInfo 创建
    const uid = String(pu.efsPosixUid)
    const gid = String(pu.efsPosixGid)
    this.accessPoint = new efs.CfnAccessPoint(this, 'AccessPoint', {
      fileSystemId: this.fileSystem.ref,
      posixUser: { uid, gid },
      rootDirectory: { path: '/home', creationInfo: { ownerUid: uid, ownerGid: gid, permissions: '0750' } },
      accessPointTags: [{ key: 'Name', value: `dsh-per-user-${user}` }],
    })
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'EfsMount',
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [this.fileSystem.attrArn],
      conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': this.accessPoint.attrArn } },
    }))
    // Runtime 创建时 AgentCore 用执行角色校验访问点与挂载目标（实测缺少时 CreateAgentRuntime 返回
    // "Execution role is missing required filesystem permissions"；文件系统配置文档里没有列出）
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'EfsDescribe',
      actions: ['elasticfilesystem:DescribeAccessPoints', 'elasticfilesystem:DescribeMountTargets'],
      resources: [this.fileSystem.attrArn, this.accessPoint.attrArn],
    }))

    const env = adapterEnv(p, deepseekKey.secretArn)
    delete env.DSH_HOME_MIRROR_MS
    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: userRuntimeName(user),
      description: `DSH per-user runtime for ${user} (data on its own EFS file system)`,
      roleArn: this.role.roleArn,
      // per-user-entry.js 先等 EFS 挂载出现，再加载 app.js（见 services/adapter/per-user/per-user-entry.js）
      agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, runtime: 'NODE_22', entryPoint: ['per-user-entry.js'] } },
      networkConfiguration: { networkMode: 'VPC', networkModeConfig: { subnets: net.privateSubnets.map((s) => s.ref), securityGroups: [net.runtimeSg.attrGroupId] } },
      protocolConfiguration: 'HTTP',
      // EFS 支持硬链接：DSH_HOME 直接放在挂载点上
      environmentVariables: { ...env, DSH_HOME_MIRROR: '0' },
      filesystemConfigurations: [{ efsAccessPoint: { accessPointArn: this.accessPoint.attrArn, mountPath: MOUNT_PATH } }],
      // /ws 上 AgentCore 只转发写成 Authorization 的头（Spike 06 C15）
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      authorizerConfiguration: jwtAuthorizer(this, auth, [{
        inboundTokenClaimName: 'username',
        inboundTokenClaimValueType: 'STRING',
        authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: user } },
      }]),
      lifecycleConfiguration: { idleRuntimeSessionTimeout: p.idleRuntimeSessionTimeoutSeconds, maxLifetime: p.maxLifetimeSeconds },
    })
    // 创建时就要能读代码包（经 S3 网关端点）、挂载 EFS（挂载目标可用）并出网（适配器启动时读取 DeepSeek key）
    this.runtime.node.addDependency(this.role)
    for (const mt of mountTargets) this.runtime.node.addDependency(mt)
    for (const e of net.egress) this.runtime.node.addDependency(e)
  }

  /** arn:<partition>:bedrock-agentcore:<region>:<account>:runtime/（后接 Runtime ID） */
  static arnPrefix(): string {
    return `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:runtime/`
  }
}

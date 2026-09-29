// NetworkConstruct（每用户 Runtime 部署）：VPC + 每个可用区一个公有子网（NAT 网关）与一个私有子网 + 两个安全组。
// 默认单可用区（vpcAzIds 一个），两个可用区时每个可用区各有自己的 NAT，私有子网只走本可用区的 NAT（没有跨可用区出网）。
// EFS 挂载要求 Runtime 使用 VPC 网络模式；AgentCore 的网卡没有公网地址，出网（Bedrock、DeepSeek、Secrets Manager、
// 用户在 bash 里的 npm/pip/git）必须经私有子网 → NAT 网关。
// 子网按可用区 ID 创建（AgentCore 只支持部分可用区，而名称到 ID 的映射因账号而异），所以这里用 L1 资源而不是 ec2.Vpc。

import { Aws, Fn, Tags } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import type { PerUserParams } from './params.js'

export class NetworkConstruct extends Construct {
  readonly vpc: ec2.CfnVPC
  /** 每个可用区一个；Runtime 与 EFS 挂载目标都放在这里 */
  readonly privateSubnets: ec2.CfnSubnet[]
  /** Runtime 网卡的安全组：出站全部放行（与原 PUBLIC 网络模式一致） */
  readonly runtimeSg: ec2.CfnSecurityGroup
  /** EFS 挂载目标的安全组：只允许来自 Runtime 安全组的 NFS（TCP 2049） */
  readonly efsSg: ec2.CfnSecurityGroup
  /** 私有子网的出网路由与 S3 网关端点（Runtime 创建后启动时就要下载代码包、读取 DeepSeek key，Runtime 依赖它们） */
  readonly egress: Construct[] = []

  constructor(scope: Construct, id: string, pu: PerUserParams) {
    super(scope, id)
    // EFS 挂载目标主机名 <az-id>.<fs-id>.efs.<region>.amazonaws.com 需要 VPC DNS
    this.vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: pu.vpcCidr, enableDnsSupport: true, enableDnsHostnames: true })
    Tags.of(this.vpc).add('Name', 'dsh-per-user')
    // /16 切成 /20：第 i 个可用区的公有子网用第 2i 块，私有子网用第 2i+1 块
    const cidrs = Fn.cidr(this.vpc.attrCidrBlock, 4, '12')
    const igw = new ec2.CfnInternetGateway(this, 'Igw')
    const igwAttach = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttach', { vpcId: this.vpc.ref, internetGatewayId: igw.ref })
    const publicRt = new ec2.CfnRouteTable(this, 'PublicRouteTable', { vpcId: this.vpc.ref })
    const publicRoute = new ec2.CfnRoute(this, 'PublicDefaultRoute', { routeTableId: publicRt.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref })
    publicRoute.node.addDependency(igwAttach)

    const privateRts: ec2.CfnRouteTable[] = []
    this.privateSubnets = pu.vpcAzIds.map((az, i) => {
      const n = i + 1
      const pub = new ec2.CfnSubnet(this, `Public${n}`, { vpcId: this.vpc.ref, availabilityZoneId: az, cidrBlock: Fn.select(2 * i, cidrs), mapPublicIpOnLaunch: false })
      new ec2.CfnSubnetRouteTableAssociation(this, `Public${n}Assoc`, { subnetId: pub.ref, routeTableId: publicRt.ref })
      Tags.of(pub).add('Name', `dsh-per-user-public-${az}`)
      const eip = new ec2.CfnEIP(this, `NatEip${n}`, { domain: 'vpc' })
      eip.node.addDependency(igwAttach)
      const nat = new ec2.CfnNatGateway(this, `Nat${n}`, { subnetId: pub.ref, allocationId: eip.attrAllocationId })
      nat.node.addDependency(publicRoute)
      Tags.of(nat).add('Name', `dsh-per-user-${az}`)

      const priv = new ec2.CfnSubnet(this, `Private${n}`, { vpcId: this.vpc.ref, availabilityZoneId: az, cidrBlock: Fn.select(2 * i + 1, cidrs), mapPublicIpOnLaunch: false })
      const rt = new ec2.CfnRouteTable(this, `PrivateRouteTable${n}`, { vpcId: this.vpc.ref })
      new ec2.CfnSubnetRouteTableAssociation(this, `Private${n}Assoc`, { subnetId: priv.ref, routeTableId: rt.ref })
      this.egress.push(new ec2.CfnRoute(this, `PrivateDefaultRoute${n}`, { routeTableId: rt.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: nat.ref }))
      Tags.of(priv).add('Name', `dsh-per-user-private-${az}`)
      privateRts.push(rt)
      return priv
    })
    // S3 网关端点（免费）：2026-05 之后新建的 VPC 模式 Runtime 不再有服务托管的 S3 网关，启动时经本 VPC 从 S3 下载代码包；
    // 走网关端点不经 NAT（也省 NAT 数据处理费）
    this.egress.push(new ec2.CfnVPCEndpoint(this, 'S3Endpoint', { vpcId: this.vpc.ref, serviceName: `com.amazonaws.${Aws.REGION}.s3`, vpcEndpointType: 'Gateway', routeTableIds: privateRts.map((r) => r.ref) }))

    this.runtimeSg = new ec2.CfnSecurityGroup(this, 'RuntimeSg', {
      vpcId: this.vpc.ref,
      groupDescription: 'DSH per-user AgentCore Runtime ENIs: all outbound',
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'all outbound (model, DeepSeek, AWS APIs, user tools)' }],
    })
    this.efsSg = new ec2.CfnSecurityGroup(this, 'EfsSg', {
      vpcId: this.vpc.ref,
      groupDescription: 'DSH per-user EFS mount targets: NFS from the runtime security group only',
      securityGroupEgress: [{ ipProtocol: 'icmp', fromPort: 252, toPort: 86, cidrIp: '255.255.255.255/32', description: 'no outbound (placeholder rule, same as CDK allowAllOutbound=false)' }],
    })
    new ec2.CfnSecurityGroupIngress(this, 'EfsFromRuntime', { groupId: this.efsSg.attrGroupId, ipProtocol: 'tcp', fromPort: 2049, toPort: 2049, sourceSecurityGroupId: this.runtimeSg.attrGroupId, description: 'NFS from AgentCore Runtime ENIs' })
  }
}

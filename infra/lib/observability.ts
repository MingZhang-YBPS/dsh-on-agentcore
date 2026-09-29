// ObservabilityConstruct：Runtime 日志组保留期 + CloudWatch Dashboard。
// Runtime 的日志组 /aws/bedrock-agentcore/runtimes/<id>-DEFAULT 由服务创建（Spike 08）。这里用 LogRetention
// （已存在则只设置保留期，不存在则创建）而不是 LogGroup，避免和服务抢着创建而报「已存在」；删除栈时一并删除。
// 这些资源只引用 Runtime 的不可变属性（ID），不会让 Runtime 产生新版本。

import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as cw from 'aws-cdk-lib/aws-cloudwatch'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import type { Params } from './params.js'
import { retentionOf, type TunnelConstruct } from './tunnel.js'

export class ObservabilityConstruct extends Construct {
  readonly runtimeLogGroupNames: string[]
  readonly dashboard: cw.Dashboard

  /**
   * runtimeIds：键 → Runtime ID。共享 Runtime 部署传 { '': id }（构造 ID 保持 RuntimeLogRetention）；
   * 每用户部署传 { <用户名>: id }（构造 ID 为 RuntimeLogRetention-<用户名>）。
   * 日志查询面板最多引用 50 个日志组（Logs Insights 上限），超出的用户只设置保留期、不进面板。
   * manageRetention=false：保留期由调用方设置（DshPerUser 在各用户的嵌套栈里由路由自定义资源设置），这里只建面板。
   */
  constructor(scope: Construct, id: string, p: Params, runtimeIds: Record<string, string>, tunnel: TunnelConstruct, distribution: cloudfront.Distribution, manageRetention = true) {
    super(scope, id)
    this.runtimeLogGroupNames = []
    for (const [key, runtimeId] of Object.entries(runtimeIds)) {
      const logGroupName = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`
      this.runtimeLogGroupNames.push(logGroupName)
      if (manageRetention) new logs.LogRetention(this, key ? `RuntimeLogRetention-${key}` : 'RuntimeLogRetention', {
        logGroupName,
        retention: retentionOf(p.logRetentionDays),
        removalPolicy: RemovalPolicy.DESTROY,
      })
    }

    const fn = tunnel.fn
    const tunnelLogs = [tunnel.logGroup.logGroupName]
    const runtimeLogs = this.runtimeLogGroupNames.slice(0, 50)
    const period = Duration.minutes(5)
    this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      defaultInterval: Duration.hours(6),
      widgets: [
        [
          new cw.LogQueryWidget({
            title: '隧道：响应状态码分布（tunnel 日志）', logGroupNames: tunnelLogs, width: 12, height: 6, view: cw.LogQueryVisualizationType.BAR,
            queryLines: ['filter msg = "tunnel"', 'stats count(*) as requests by status', 'sort requests desc'],
          }),
          new cw.LogQueryWidget({
            title: '隧道：登录、续期与 AgentCore 错误', logGroupNames: tunnelLogs, width: 12, height: 6, view: cw.LogQueryVisualizationType.TABLE,
            queryLines: ['filter msg in ["login ok", "login rejected", "token refreshed", "token refresh failed", "agentcore rejected token", "agentcore error", "tunnel handler error"]', 'stats count(*) as n by msg, reason, status', 'sort n desc'],
          }),
        ],
        [
          new cw.GraphWidget({ title: 'Lambda 调用 / 错误 / 限流', width: 12, left: [fn.metricInvocations({ period }), fn.metricErrors({ period }), fn.metricThrottles({ period })] }),
          new cw.GraphWidget({ title: 'Lambda 耗时（p50 / p99）', width: 12, left: [fn.metricDuration({ period, statistic: 'p50' }), fn.metricDuration({ period, statistic: 'p99' })] }),
        ],
        [
          new cw.LogQueryWidget({
            title: '适配器 warn / error 计数', logGroupNames: runtimeLogs, width: 12, height: 6, view: cw.LogQueryVisualizationType.LINE,
            queryLines: ['filter level = "warn" or level = "error"', 'stats count(*) by level, bin(5m)'],
          }),
          new cw.LogQueryWidget({
            title: '冷启动：适配器启动到 DSH 就绪（ms）', logGroupNames: runtimeLogs, width: 12, height: 6, view: cw.LogQueryVisualizationType.TABLE,
            queryLines: ['filter msg = "dsh web ready"', 'stats count(*) as starts, avg(readyMs) as avgMs, pct(readyMs, 90) as p90Ms, max(readyMs) as maxMs by bin(1h)'],
          }),
        ],
        [
          new cw.GraphWidget({
            title: 'CloudFront 请求数', width: 12,
            left: [distribution.metricRequests({ period, statistic: 'Sum', region: 'us-east-1' })],
          }),
          new cw.GraphWidget({
            title: 'CloudFront 4xx / 5xx 错误率（%）', width: 12,
            left: [distribution.metric4xxErrorRate({ period, region: 'us-east-1' }), distribution.metric5xxErrorRate({ period, region: 'us-east-1' })],
          }),
        ],
        [
          new cw.LogQueryWidget({
            title: '适配器最近的 warn / error', logGroupNames: runtimeLogs, width: 24, height: 6, view: cw.LogQueryVisualizationType.TABLE,
            queryLines: ['fields @timestamp, level, msg, sessionId, reason, error', 'filter level = "warn" or level = "error"', 'sort @timestamp desc', 'limit 50'],
          }),
        ],
      ],
    })
  }
}

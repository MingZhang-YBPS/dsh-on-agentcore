// destroy：删除整个栈（含所有用户的数据），逐项输出删除结果，30 分钟计时；最后按前缀删除服务自动创建的日志组。
//   npm run destroy -- --confirm-delete-user-data [-c key=value ...]
// Runtime 的日志组 /aws/bedrock-agentcore/runtimes/<id>-* 由服务创建，删除栈时不会一并删除（Spike 08）；
// 自定义资源框架函数的 /aws/lambda/DshPoc-* 日志组同理。只有栈删除成功后才清理日志组。

import { CloudFormationClient, type StackEvent } from '@aws-sdk/client-cloudformation'
import { CloudWatchLogsClient, DeleteLogGroupCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { RUNTIME_NAME } from '../lib/runtime.js'
import { CDK_BIN, STACK_NAME, contextArgs, describeStack, eventsSince, fail, outputOf, parseCli, resolveRegion, run, sleep, ts } from './common.js'

const TIMEOUT_MS = 30 * 60_000
const POLL_MS = 5_000

async function logGroupsWithPrefix(logs: CloudWatchLogsClient, prefix: string): Promise<string[]> {
  const names: string[] = []
  let nextToken: string | undefined
  do {
    const r = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }))
    for (const g of r.logGroups ?? []) if (g.logGroupName) names.push(g.logGroupName)
    nextToken = r.nextToken
  } while (nextToken)
  return names
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2), ['--confirm-delete-user-data'])
  if (!cli.flags.has('--confirm-delete-user-data')) {
    fail('destroy deletes the whole stack, including every user\'s DSH home, conversations and workspace files (session storage), the user pool and all secrets.\nRe-run with --confirm-delete-user-data to proceed.', 3)
  }
  const region = await resolveRegion()
  const cfn = new CloudFormationClient({ region })
  const logs = new CloudWatchLogsClient({ region })
  const started = Date.now()

  const stack = await describeStack(cfn)
  const runtimeId = outputOf(stack, 'AgentRuntimeId')
  if (!stack) {
    console.log(`== stack ${STACK_NAME} does not exist in ${region}`)
  } else {
    console.log(`== deleting stack ${STACK_NAME} (${stack.StackStatus}) in ${region}; timeout ${TIMEOUT_MS / 60_000} min`)
    const since = new Date(Date.now() - 5_000)
    const d = run(CDK_BIN, ['destroy', STACK_NAME, '--force', ...contextArgs(cli)])
    let exited: { code: number } | undefined
    void d.done.then((r) => { exited = r })
    const seen = new Set<string>()
    const report = (evs: StackEvent[]) => {
      for (const e of evs) {
        if (!e.EventId || seen.has(e.EventId) || !/^DELETE_(COMPLETE|FAILED|SKIPPED)$/.test(e.ResourceStatus ?? '')) continue
        seen.add(e.EventId)
        const reason = e.ResourceStatus === 'DELETE_COMPLETE' ? '' : ` ${e.ResourceStatusReason ?? ''}`
        console.log(`   [${ts()}] ${e.ResourceStatus} ${e.LogicalResourceId} (${e.ResourceType})${reason}`)
      }
    }
    // 用 StackId 查询：栈删除后按名称已经查不到事件
    const stackId = stack.StackId ?? STACK_NAME
    for (;;) {
      await sleep(POLL_MS)
      report(await eventsSince(cfn, since, stackId).catch(() => []))
      if (exited) break
      if (Date.now() - started > TIMEOUT_MS) {
        d.kill()
        const s = await describeStack(cfn, stackId).catch(() => undefined)
        fail(`destroy did not finish within ${TIMEOUT_MS / 60_000} minutes (stack status ${s?.StackStatus ?? 'unknown'}); check the CloudFormation console`)
      }
    }
    const s = await describeStack(cfn, stackId).catch(() => undefined)
    const code = (exited as { code: number } | undefined)?.code ?? 1
    if (code !== 0 || (s && s.StackStatus !== 'DELETE_COMPLETE')) fail(`cdk destroy failed (exit ${code}, stack status ${s?.StackStatus ?? 'unknown'}); log groups were left in place`)
    console.log(`   stack deleted in ${Math.round((Date.now() - started) / 1000)} s`)
  }

  // 已知 Runtime ID 时只删该 Runtime 的日志组；否则按 Runtime 名称前缀（名称在账号区域内唯一，栈删除后不再有同名 Runtime）
  const prefixes = [runtimeId ? `/aws/bedrock-agentcore/runtimes/${runtimeId}-` : `/aws/bedrock-agentcore/runtimes/${RUNTIME_NAME}-`, `/aws/lambda/${STACK_NAME}-`]
  console.log('== deleting leftover log groups')
  let n = 0
  for (const prefix of prefixes) {
    for (const name of await logGroupsWithPrefix(logs, prefix)) {
      try {
        await logs.send(new DeleteLogGroupCommand({ logGroupName: name }))
        console.log(`   DELETED ${name}`)
        n++
      } catch (e) {
        console.log(`   FAILED  ${name}: ${(e as Error).message}`)
      }
    }
  }
  if (n === 0) console.log('   (none)')
  console.log(`destroy finished in ${Math.round((Date.now() - started) / 1000)} s`)
}

await main()

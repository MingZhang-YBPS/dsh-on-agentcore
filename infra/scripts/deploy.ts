// deploy：preflight → 构建适配器代码包 → 数据清空保护 → cdk deploy（CloudFormation 默认回滚）+ 轮询栈状态。
//   [DEEPSEEK_API_KEY=sk-...] npm run deploy -- [-c key=value ...] [--skip-preflight] [--skip-build]
// DEEPSEEK_API_KEY_<用户>（可选，每用户部署）：列在 -c deepseekSecretPerUser=... 中的用户自己的 DeepSeek key（用户名大写，- 换成 _）。
// DEEPSEEK_API_KEY（可选）：网页搜索用的 DeepSeek 官方 API key。部署成功后写入栈里的 secret（DeepSeekApiKeySecretArn），
// 不进入 CDK context、模板或 Runtime 配置，所以设置或轮换 key 不会产生新的 Runtime 版本；新的 microVM 启动时读取。
// 数据清空保护（Spike 08）：Runtime 的任何属性变更都会产生新版本并清空所有用户的 session storage。
// 栈已存在且 cdk diff 中出现 AWS::BedrockAgentCore::Runtime 的变更时，必须显式传 -c acceptDataWipe=true。
// 每用户部署（-c stack=DshPerUser，npm run deploy:per-user）：数据在各用户的 EFS 上，Runtime 变更不清空数据，不需要 acceptDataWipe；
// 但 diff 中出现 EFS 文件系统的删除或替换（从 demoUsers 去掉用户、改了需替换的属性）时同样必须 -c acceptDataWipe=true。
// 失败处理：不用 --no-rollback（栈会停在 UPDATE_FAILED，修复后重新部署报告 no changes，必须先 cdk rollback）。
// 轮询 describe-stacks，一旦进入 *_FAILED / *ROLLBACK*，立即从栈事件输出失败资源与原因，等回滚结束后以非零退出。

import { CloudFormationClient } from '@aws-sdk/client-cloudformation'
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDK_BIN, INFRA_DIR, REPO_ROOT, contextArgs, isPerUser, stackNameOf, describeStack, nestedStacks, eventsSince, fail, isTrue, mergedContext, outputOf, parseCli, resolveRegion, run, sleep, ts } from './common.js'
import { userDeepSeekKeyEnv } from '../lib/params.js'
import { efsFileSystemsAtRisk, runtimeChanged } from './deploy-guard.js'
import { preflight } from './preflight.js'

const POLL_MS = 10_000
const BAD = /(_FAILED|ROLLBACK)/
const TERMINAL = /(_COMPLETE|_FAILED)$/
const NOT_DEPLOYABLE = /(_IN_PROGRESS|^ROLLBACK_COMPLETE|^ROLLBACK_FAILED|^DELETE_FAILED|^UPDATE_FAILED)$/

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2), ['--skip-preflight', '--skip-build'])
  const region = await resolveRegion()
  const cfn = new CloudFormationClient({ region })
  const ctx = mergedContext(cli)
  const cArgs = contextArgs(cli)
  const STACK_NAME = stackNameOf(cli)
  const perUser = isPerUser(STACK_NAME)
  console.log(`== target stack ${STACK_NAME}${perUser ? ' (one AgentCore Runtime + one EFS file system per user)' : ' (shared Runtime, session storage)'}`)
  if (Object.keys(cli.context).some((k) => /deepseek.*key|apikey/i.test(k))) fail('pass the DeepSeek API key through the DEEPSEEK_API_KEY environment variable, not as CDK context (context values end up in cdk.out)')

  if (!cli.flags.has('--skip-preflight')) await preflight(cli)

  if (!cli.flags.has('--skip-build')) {
    console.log('== build adapter package (reproducible: unchanged inputs => unchanged asset => no new Runtime version)')
    const b = await run('bash', [join(INFRA_DIR, 'scripts', 'build-adapter.sh')], { cwd: REPO_ROOT, env: { ...process.env, ADAPTER_ARCH: 'arm64' } }).done
    if (b.code !== 0) fail('adapter build failed')
  }

  const before = await describeStack(cfn, STACK_NAME)
  if (before) {
    const st = before.StackStatus ?? ''
    if (NOT_DEPLOYABLE.test(st)) {
      fail(st === 'ROLLBACK_COMPLETE'
        ? `stack ${STACK_NAME} is ROLLBACK_COMPLETE (the first deploy failed); run npm run destroy -- --confirm-delete-user-data, then deploy again`
        : `stack ${STACK_NAME} is ${st}; wait for it to finish or fix it before deploying`)
    }
    console.log(perUser ? `== cdk diff (stack exists: ${st})` : `== cdk diff (stack exists: ${st}, Runtime version ${outputOf(before, 'AgentRuntimeVersion') ?? '?'})`)
    const d = await run(CDK_BIN, ['diff', STACK_NAME, '--no-color', ...cArgs], { capture: true }).done
    process.stdout.write(d.out)
    if (d.code !== 0) fail('cdk diff failed')
    if (perUser) {
      const atRisk = efsFileSystemsAtRisk(d.out)
      if (atRisk.length && !isTrue(ctx.acceptDataWipe)) {
        fail(`this deploy DELETES OR REPLACES EFS file systems, which permanently deletes those users' DSH home, conversations and workspace files:\n  ${atRisk.join('\n  ')}\n` +
          'Re-run with -c acceptDataWipe=true to proceed.', 3)
      }
      if (atRisk.length) console.log('!! acceptDataWipe=true: the EFS file systems listed above will be deleted or replaced')
      if (runtimeChanged(d.out)) console.log('   Runtime changes detected: users keep their data (it is on EFS); running microVMs switch to the new version when they are recycled')
    } else if (runtimeChanged(d.out)) {
      if (!isTrue(ctx.acceptDataWipe)) {
        fail('this deploy changes AWS::BedrockAgentCore::Runtime, which creates a new Runtime version and WIPES THE SESSION STORAGE (DSH home, conversations, workspace files) OF ALL USERS.\n' +
          'The wipe happens lazily as each user\'s microVM is recycled. Re-run with -c acceptDataWipe=true to proceed.', 3)
      }
      console.log('!! acceptDataWipe=true: the Runtime will get a new version; all users\' session storage will be wiped as their microVMs are recycled')
    }
  }

  console.log('== cdk deploy')
  const start = new Date(Date.now() - 5_000)
  mkdirSync(join(INFRA_DIR, 'build'), { recursive: true })
  const outputsFile = join(INFRA_DIR, 'build', perUser ? `outputs-${STACK_NAME}.json` : 'outputs.json')
  const deploy = run(CDK_BIN, ['deploy', STACK_NAME, '--require-approval', 'never', '--outputs-file', outputsFile, ...cArgs])
  let exited: { code: number } | null = null
  void deploy.done.then((r) => { exited = r })

  let reported = false
  while (!exited) {
    await sleep(POLL_MS)
    if (exited) break
    const s = await describeStack(cfn, STACK_NAME).catch(() => undefined)
    const st = s?.StackStatus ?? ''
    if (!s || !BAD.test(st)) continue
    // 只处理本次部署触发的状态（之前失败留下的 UPDATE_ROLLBACK_COMPLETE 不算）
    const evs = await eventsSince(cfn, start, STACK_NAME).catch(() => [])
    if (evs.length === 0) continue
    if (!reported) {
      reported = true
      console.error(`\n!! [${ts()}] stack entered ${st}; failed resources:`)
      for (const e of evs.filter((x) => x.ResourceStatus?.endsWith('_FAILED'))) {
        console.error(`   - ${e.LogicalResourceId} (${e.ResourceType}) ${e.ResourceStatus}: ${e.ResourceStatusReason ?? ''}`)
        // 嵌套栈（每用户部署）：父栈只给出「Embedded stack … was not successfully …」，真正的原因在嵌套栈的事件里
        if (e.ResourceType === 'AWS::CloudFormation::Stack' && e.PhysicalResourceId) {
          for (const n of (await eventsSince(cfn, start, e.PhysicalResourceId).catch(() => [])).filter((x) => x.ResourceStatus?.endsWith('_FAILED') && x.ResourceType !== 'AWS::CloudFormation::Stack')) {
            console.error(`       · ${n.LogicalResourceId} (${n.ResourceType}) ${n.ResourceStatus}: ${n.ResourceStatusReason ?? ''}`)
          }
        }
      }
      console.error('   waiting for CloudFormation to finish the rollback…')
    }
    if (TERMINAL.test(st) && !st.endsWith('_IN_PROGRESS')) {
      console.error(`!! [${ts()}] stack is ${st}`)
      deploy.kill()
      process.exit(1)
    }
  }
  const code = (exited as { code: number } | null)?.code ?? 1
  if (code !== 0 || reported) fail(`cdk deploy failed (exit ${code})`)

  const after = await describeStack(cfn, STACK_NAME)
  const outs = JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>
  const o = outs[STACK_NAME] ?? {}
  console.log('\n== deployed')
  for (const k of ['WebUrl', ...(perUser ? ['VpcId'] : ['AgentRuntimeArn', 'AgentRuntimeVersion']), 'EffectiveModelId', 'EffectiveModelRegion', 'EffectiveModelEndpointSurface', 'MockModel', 'UserPoolId']) console.log(`   ${k}: ${o[k] ?? '?'}`)
  const perUserStacks = perUser
    ? (await nestedStacks(cfn, STACK_NAME)).filter((n) => outputOf(n, 'Username')).sort((a, b) => (outputOf(a, 'Username') ?? '').localeCompare(outputOf(b, 'Username') ?? ''))
    : []
  if (perUser) {
    // 每名用户的输出在其嵌套栈上
    console.log(`   users (${perUserStacks.length}):`)
    for (const n of perUserStacks) {
      console.log(`   - ${outputOf(n, 'Username')}: runtime ${outputOf(n, 'AgentRuntimeArn')} (v${outputOf(n, 'AgentRuntimeVersion')}), EFS ${outputOf(n, 'EfsFileSystemId')}`)
      console.log(`     password secret ${outputOf(n, 'UserSecretArn')}`)
    }
  }
  for (const [k, v] of Object.entries(o)) if (k.startsWith('UserSecret')) console.log(`   ${k}: ${v}   (aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text)`)
  // DeepSeek key 只从环境变量写入 secret，不经过 context 或模板；写入不改动 Runtime
  const sm = new SecretsManagerClient({ region })
  const currentKey = (arn: string) => sm.send(new GetSecretValueCommand({ SecretId: arn })).then((r) => r.SecretString, () => undefined)
  const storeKey = async (arn: string, key: string, label: string): Promise<void> => {
    if ((await currentKey(arn)) === key) { console.log(`   ${label}: unchanged`); return }
    await sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: key }))
    console.log(`   ${label}: stored (…${key.slice(-4)}); microVMs started from now on use it (running ones pick it up within 5 minutes; the web-search card's "configured" state updates after the microVM is recycled)`)
  }
  const dsKey = process.env.DEEPSEEK_API_KEY?.trim()
  const dsArn = o.DeepSeekApiKeySecretArn
  const sharedLabel = perUser ? 'DeepSeek API key (shared)' : 'DeepSeek API key'
  if (dsKey && dsArn) await storeKey(dsArn, dsKey, sharedLabel)
  else if (dsArn) console.log(`   ${sharedLabel}: DEEPSEEK_API_KEY not set, stored value left unchanged`)
  // 每用户部署：列在 deepseekSecretPerUser 中的用户有自己的 secret，从 DEEPSEEK_API_KEY_<用户> 写入
  for (const n of perUserStacks) {
    const user = outputOf(n, 'Username') ?? ''
    const arn = outputOf(n, 'DeepSeekApiKeySecretArn')
    const envName = userDeepSeekKeyEnv(user)
    const key = process.env[envName]?.trim()
    if (outputOf(n, 'DeepSeekKeyScope') !== 'user' || !arn) {
      if (key) console.log(`!! ${envName} is set but ${user} uses the shared DeepSeek key (add ${user} to -c deepseekSecretPerUser=... to give it its own); ignored`)
      continue
    }
    if (key) await storeKey(arn, key, `DeepSeek API key of ${user}`)
    else console.log(`   DeepSeek API key of ${user}: ${envName} not set, stored value left unchanged (${(await currentKey(arn)) === 'not-configured' ? 'NOT CONFIGURED: this user has no DeepSeek models or web search' : 'configured'})`)
  }
  const v0 = outputOf(before, 'AgentRuntimeVersion')
  const v1 = outputOf(after, 'AgentRuntimeVersion')
  if (v0 && v1 && v0 !== v1) console.log(`!! Runtime version changed ${v0} -> ${v1}: users' session storage will be wiped as their microVMs are recycled`)
}

await main()

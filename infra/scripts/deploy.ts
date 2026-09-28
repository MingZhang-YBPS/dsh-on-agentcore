// deploy：preflight → 构建适配器代码包 → 数据清空保护 → cdk deploy（CloudFormation 默认回滚）+ 轮询栈状态。
//   [DEEPSEEK_API_KEY=sk-...] npm run deploy -- [-c key=value ...] [--skip-preflight] [--skip-build]
// DEEPSEEK_API_KEY（可选）：网页搜索用的 DeepSeek 官方 API key。部署成功后写入栈里的 secret（DeepSeekApiKeySecretArn），
// 不进入 CDK context、模板或 Runtime 配置，所以设置或轮换 key 不会产生新的 Runtime 版本；新的 microVM 启动时读取。
// 数据清空保护（Spike 08）：Runtime 的任何属性变更都会产生新版本并清空所有用户的 session storage。
// 栈已存在且 cdk diff 中出现 AWS::BedrockAgentCore::Runtime 的变更时，必须显式传 -c acceptDataWipe=true。
// 失败处理：不用 --no-rollback（栈会停在 UPDATE_FAILED，修复后重新部署报告 no changes，必须先 cdk rollback）。
// 轮询 describe-stacks，一旦进入 *_FAILED / *ROLLBACK*，立即从栈事件输出失败资源与原因，等回滚结束后以非零退出。

import { CloudFormationClient } from '@aws-sdk/client-cloudformation'
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDK_BIN, INFRA_DIR, REPO_ROOT, STACK_NAME, contextArgs, describeStack, eventsSince, fail, isTrue, mergedContext, outputOf, parseCli, resolveRegion, run, sleep, ts } from './common.js'
import { runtimeChanged } from './deploy-guard.js'
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
  if (Object.keys(cli.context).some((k) => /deepseek.*key|apikey/i.test(k))) fail('pass the DeepSeek API key through the DEEPSEEK_API_KEY environment variable, not as CDK context (context values end up in cdk.out)')

  if (!cli.flags.has('--skip-preflight')) await preflight(cli)

  if (!cli.flags.has('--skip-build')) {
    console.log('== build adapter package (reproducible: unchanged inputs => unchanged asset => no new Runtime version)')
    const b = await run('bash', [join(INFRA_DIR, 'scripts', 'build-adapter.sh')], { cwd: REPO_ROOT, env: { ...process.env, ADAPTER_ARCH: 'arm64' } }).done
    if (b.code !== 0) fail('adapter build failed')
  }

  const before = await describeStack(cfn)
  if (before) {
    const st = before.StackStatus ?? ''
    if (NOT_DEPLOYABLE.test(st)) {
      fail(st === 'ROLLBACK_COMPLETE'
        ? `stack ${STACK_NAME} is ROLLBACK_COMPLETE (the first deploy failed); run npm run destroy -- --confirm-delete-user-data, then deploy again`
        : `stack ${STACK_NAME} is ${st}; wait for it to finish or fix it before deploying`)
    }
    console.log(`== cdk diff (stack exists: ${st}, Runtime version ${outputOf(before, 'AgentRuntimeVersion') ?? '?'})`)
    const d = await run(CDK_BIN, ['diff', STACK_NAME, '--no-color', ...cArgs], { capture: true }).done
    process.stdout.write(d.out)
    if (d.code !== 0) fail('cdk diff failed')
    if (runtimeChanged(d.out)) {
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
  const outputsFile = join(INFRA_DIR, 'build', 'outputs.json')
  const deploy = run(CDK_BIN, ['deploy', STACK_NAME, '--require-approval', 'never', '--outputs-file', outputsFile, ...cArgs])
  let exited: { code: number } | null = null
  void deploy.done.then((r) => { exited = r })

  let reported = false
  while (!exited) {
    await sleep(POLL_MS)
    if (exited) break
    const s = await describeStack(cfn).catch(() => undefined)
    const st = s?.StackStatus ?? ''
    if (!s || !BAD.test(st)) continue
    // 只处理本次部署触发的状态（之前失败留下的 UPDATE_ROLLBACK_COMPLETE 不算）
    const evs = await eventsSince(cfn, start).catch(() => [])
    if (evs.length === 0) continue
    if (!reported) {
      reported = true
      console.error(`\n!! [${ts()}] stack entered ${st}; failed resources:`)
      for (const e of evs.filter((x) => x.ResourceStatus?.endsWith('_FAILED'))) {
        console.error(`   - ${e.LogicalResourceId} (${e.ResourceType}) ${e.ResourceStatus}: ${e.ResourceStatusReason ?? ''}`)
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

  const after = await describeStack(cfn)
  const outs = JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>
  const o = outs[STACK_NAME] ?? {}
  console.log('\n== deployed')
  for (const k of ['WebUrl', 'AgentRuntimeArn', 'AgentRuntimeVersion', 'EffectiveModelId', 'EffectiveModelRegion', 'EffectiveModelEndpointSurface', 'MockModel', 'UserPoolId']) console.log(`   ${k}: ${o[k] ?? '?'}`)
  for (const [k, v] of Object.entries(o)) if (k.startsWith('UserSecret')) console.log(`   ${k}: ${v}   (aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text)`)
  const dsKey = process.env.DEEPSEEK_API_KEY?.trim()
  const dsArn = o.DeepSeekApiKeySecretArn
  if (dsKey && dsArn) {
    const sm = new SecretsManagerClient({ region })
    const cur = await sm.send(new GetSecretValueCommand({ SecretId: dsArn })).then((r) => r.SecretString, () => undefined)
    if (cur === dsKey) console.log('   DeepSeek API key: unchanged')
    else {
      await sm.send(new PutSecretValueCommand({ SecretId: dsArn, SecretString: dsKey }))
      console.log(`   DeepSeek API key: stored (…${dsKey.slice(-4)}); microVMs started from now on use it (running ones pick it up within 5 minutes; the web-search card's "configured" state updates after the microVM is recycled)`)
    }
  } else if (dsArn) {
    console.log('   DeepSeek API key: DEEPSEEK_API_KEY not set, stored value left unchanged')
  }
  const v0 = outputOf(before, 'AgentRuntimeVersion')
  const v1 = outputOf(after, 'AgentRuntimeVersion')
  if (v0 && v1 && v0 !== v1) console.log(`!! Runtime version changed ${v0} -> ${v1}: users' session storage will be wiped as their microVMs are recycled`)
}

await main()

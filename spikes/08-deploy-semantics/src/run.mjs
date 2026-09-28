// 驱动：依次改变 CDK 栈里 Runtime 的单个属性并部署，每步观察
//   - cdk 的退出码、是否「no changes」、栈状态
//   - Runtime 版本（GetAgentRuntime 与 ListAgentRuntimeVersions）
//   - 同一 runtimeSessionId：部署后立即读取（仍可能是旧 microVM）与 StopRuntimeSession 后读取（强制新 microVM）时，
//     session storage 里的标记文件是否还在、microVM 的 boot_id 与环境变量 MARK
// 最后做两组失败注入：更新时失败（默认回滚 / --no-rollback 并恢复）与创建时失败（--no-rollback）。
// 结果：results/cases.jsonl、results/summary.md
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = join(DIR, 'results'); mkdirSync(RESULTS, { recursive: true })
const REGION = process.env.AWS_REGION ?? 'us-east-1'
const STACK = 'DshPocSpike08'
const AGENT_DIR = join(DIR, '.agent-build')
const rows = []
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const aws = async (...args) => JSON.parse((await exec('aws', [...args, '--output', 'json', '--region', REGION], { maxBuffer: 1 << 24 })).stdout || 'null')

function writeAgent(rev) {
  rmSync(AGENT_DIR, { recursive: true, force: true }); mkdirSync(AGENT_DIR)
  writeFileSync(join(AGENT_DIR, 'app.js'), readFileSync(join(DIR, 'agent', 'app.js'), 'utf8').replace("const CODE_REV = 'r1'", `const CODE_REV = '${rev}'`))
}

async function cdk(ctx, { noRollback = false, stack = STACK } = {}) {
  const args = ['cdk', 'deploy', stack, '--require-approval', 'never', '--outputs-file', join(DIR, `.outputs-${stack}.json`), '--progress', 'events']
  for (const [k, v] of Object.entries({ ...ctx, stack })) if (v !== undefined && v !== '') args.push('-c', `${k}=${v}`)
  if (noRollback) args.push('--no-rollback')
  const t0 = Date.now()
  let out = ''
  let code = 0
  try { const r = await exec('npx', args, { cwd: DIR, env: { ...process.env, AGENT_DIR }, maxBuffer: 1 << 26 }); out = r.stdout + r.stderr } catch (e) { out = (e.stdout ?? '') + (e.stderr ?? ''); code = e.code ?? 1 }
  const failedLines = out.split('\n').filter((l) => /FAILED|failed|Error|error:/.test(l)).slice(0, 6).map((l) => l.replace(/\s+/g, ' ').slice(0, 260))
  return { code, ms: Date.now() - t0, noChanges: /no changes/i.test(out), failedLines, tail: out.slice(-1500) }
}
const stackStatus = async (stack = STACK) => (await aws('cloudformation', 'describe-stacks', '--stack-name', stack).catch(() => null))?.Stacks?.[0]?.StackStatus ?? 'ABSENT'
const outputs = (stack = STACK) => Object.values(JSON.parse(readFileSync(join(DIR, `.outputs-${stack}.json`), 'utf8')))[0]
async function runtimeInfo(id) {
  const r = await aws('bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', id)
  const v = await aws('bedrock-agentcore-control', 'list-agent-runtime-versions', '--agent-runtime-id', id)
  return { version: r.agentRuntimeVersion, status: r.status, versions: (v.agentRuntimes ?? []).map((x) => x.agentRuntimeVersion).sort((a, b) => Number(a) - Number(b)), mark: r.environmentVariables?.MARK }
}

// ---------- 身份与调用 ----------
let tok = null
let o = null
async function token() {
  if (tok && tok.exp > Date.now() + 120000) return tok.value
  const r = await aws('cognito-idp', 'admin-initiate-auth', '--user-pool-id', o.PoolId, '--client-id', o.ClientId, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=probe,PASSWORD=${PASS}`)
  tok = { value: r.AuthenticationResult.AccessToken, exp: Date.now() + r.AuthenticationResult.ExpiresIn * 1000 }
  return tok.value
}
const PASS = `Aa1!${randomBytes(12).toString('hex')}`
const SESSION = `dsh-user-${randomUUID()}`
async function invoke(op, data) {
  const url = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(o.RuntimeArn)}/invocations?qualifier=DEFAULT`
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now()
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': SESSION }, body: JSON.stringify({ op, data }) })
    const text = await r.text()
    if (r.status === 200) return { ...JSON.parse(text), ms: Date.now() - t0 }
    log(`invoke ${op} → ${r.status} ${text.slice(0, 160)}；重试`)
    await new Promise((res) => setTimeout(res, 5000))
  }
  throw new Error(`invoke ${op} failed`)
}
// JWT 授权的 Runtime 上，StopRuntimeSession 也必须用 Bearer 令牌调用（SigV4 返回 Authorization method mismatch）
async function stopSession() {
  const r = await fetch(`https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(o.RuntimeArn)}/stopruntimesession?qualifier=DEFAULT`, {
    method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': SESSION }, body: '{}',
  })
  return r.status === 200 ? {} : { error: `${r.status} ${(await r.text()).slice(0, 200)}` }
}

// ---------- 一个变更步骤 ----------
let ctx = { mark: '1', desc: 'spike08 probe', tagv: 'a', idle: '900' }
let expected = null // 当前应在 session storage 中的标记内容
async function step(id, desc, change, { rev, noRollback = false, restore } = {}) {
  const before = await invoke('read')
  const info0 = await runtimeInfo(o.RuntimeId)
  const next = { ...ctx, ...change }
  if (rev) writeAgent(rev)
  log(`${id} ${desc}：部署 ${JSON.stringify(change)}${noRollback ? ' --no-rollback' : ''}`)
  const d = await cdk(next, { noRollback })
  const status = await stackStatus()
  const info1 = await runtimeInfo(o.RuntimeId)
  const now = await invoke('read')
  const stopped = await stopSession()
  await new Promise((r) => setTimeout(r, 3000))
  const after = await invoke('read')
  const row = {
    id, desc, change, noRollback, cdkExit: d.code, noChanges: d.noChanges, deployMs: d.ms, stackStatus: status, failedLines: d.failedLines,
    versionBefore: info0.version, versionAfter: info1.version, versionsAfter: info1.versions, runtimeStatus: info1.status, runtimeMark: info1.mark,
    dataBefore: before.data, dataImmediately: now.data, sameMicroVmImmediately: now.bootId === before.bootId, markImmediately: now.mark,
    dataAfterRestart: after.data, markAfterRestart: after.mark, codeRevAfterRestart: after.codeRev, newMicroVmAfterRestart: after.bootId !== now.bootId,
    wiped: after.data !== expected, stopError: stopped?.error,
  }
  rows.push(row)
  log(`${id}: exit=${d.code} noChanges=${d.noChanges} stack=${status} version ${info0.version}→${info1.version} [${info1.versions.join(',')}] ` +
    `立即读=${JSON.stringify(now.data)}(同 VM=${row.sameMicroVmImmediately}, MARK=${now.mark}) 重启后读=${JSON.stringify(after.data)}(MARK=${after.mark}, rev=${after.codeRev}) wiped=${row.wiped}`)
  if (d.code === 0 || restore === 'keep') ctx = next
  if (restore && typeof restore === 'object') ctx = { ...ctx, ...restore }
  if (row.wiped || after.data == null) { expected = `after-${id}`; await invoke('write', expected) }
  return row
}

// ========== S0：创建 ==========
writeAgent('r1')
log('S0 创建栈')
const d0 = await cdk(ctx)
if (d0.code !== 0) { console.log(d0.tail); process.exit(1) }
o = outputs()
await aws('cognito-idp', 'admin-create-user', '--user-pool-id', o.PoolId, '--username', 'probe', '--message-action', 'SUPPRESS').catch(() => {})
await aws('cognito-idp', 'admin-set-user-password', '--user-pool-id', o.PoolId, '--username', 'probe', '--password', PASS, '--permanent')
const i0 = await runtimeInfo(o.RuntimeId)
expected = 'v1-data'
const w = await invoke('write', expected)
const r0 = await invoke('read')
rows.push({ id: 'S0', desc: 'CDK 创建栈（CfnRuntime：session storage + 请求头白名单 + JWT 授权器），写入标记', cdkExit: d0.code, deployMs: d0.ms, stackStatus: await stackStatus(), versionAfter: i0.version, versionsAfter: i0.versions, dataAfterRestart: r0.data, authHeaderForwarded: r0.authHeader, firstInvokeMs: w.ms })
log(`S0: version ${i0.version} 读=${r0.data} Authorization 转发=${r0.authHeader} 首次调用 ${w.ms} ms，部署 ${d0.ms} ms`)

await step('S1', '参数不变重复部署', {})
await step('S2', '只 StopRuntimeSession（对照：同版本下恢复 session storage）', {})
await step('S3', '只改标签（Tags.rev）', { tagv: 'b' })
await step('S4', '只改 Description', { desc: 'spike08 probe v2' })
await step('S5', '只改环境变量（MARK=2）', { mark: '2' })
await step('S6', '只改 lifecycleConfiguration.idleRuntimeSessionTimeout（900→901）', { idle: '901' })
await step('S7', '只改代码包内容（CODE_REV r1→r2）', {}, { rev: 'r2' })
await step('S8', '更新时失败，默认回滚（MARK=3 + 必然失败的资源）', { mark: '3', fail: 'bucket' }, { restore: { fail: '' } })
await step('S9a', '更新时失败，--no-rollback（MARK=4 + 必然失败的资源）', { mark: '4', fail: 'bucket' }, { noRollback: true, restore: 'keep' })
ctx.fail = ''
await step('S9b', '从 UPDATE_FAILED 恢复：去掉失败资源再部署', { fail: '' })

// ========== S10：创建时失败（--no-rollback） ==========
log('S10 创建时失败（新栈 + 必然失败的资源，--no-rollback）')
const FS = 'DshPocSpike08Fail'
const d10 = await cdk({ ...ctx, fail: 'bucket' }, { noRollback: true, stack: FS })
const st10 = await stackStatus(FS)
const res10 = (await aws('cloudformation', 'describe-stack-resources', '--stack-name', FS).catch(() => ({ StackResources: [] }))).StackResources.map((r) => `${r.LogicalResourceId}:${r.ResourceStatus}`)
rows.push({ id: 'S10', desc: '创建时失败，--no-rollback：已创建的资源保留，失败资源与原因可见', cdkExit: d10.code, stackStatus: st10, resources: res10, failedLines: d10.failedLines, deployMs: d10.ms })
log(`S10: exit=${d10.code} stack=${st10} 资源=${res10.join(' ')}`)
const dd = await exec('npx', ['cdk', 'destroy', FS, '--force', '-c', `stack=${FS}`], { cwd: DIR, env: { ...process.env, AGENT_DIR }, maxBuffer: 1 << 26 }).then(() => 0, (e) => e.code ?? 1)
rows.push({ id: 'S10d', desc: 'cdk destroy 删除 CREATE_FAILED 的栈', cdkExit: dd, stackStatus: await stackStatus(FS) })

writeFileSync(join(RESULTS, 'cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
const md = ['# Spike 08 结果摘要（Runtime 版本与 session storage；部署失败语义）', '', `- 运行时间：${new Date().toISOString()}；区域 ${REGION}；栈 ${STACK}`, '',
  '| 步骤 | 变更 | cdk 退出码 / no changes | 栈状态 | 版本 | 立即读（同 VM / MARK） | Stop 后读（MARK / 代码） | 清空 |', '|---|---|---|---|---|---|---|---|']
for (const x of rows) md.push(`| ${x.id} | ${x.desc} | ${x.cdkExit ?? ''} / ${x.noChanges ?? ''} | ${x.stackStatus ?? ''} | ${x.versionBefore ?? ''}→${x.versionAfter ?? ''} [${(x.versionsAfter ?? []).join(',')}] | ${x.dataImmediately === undefined ? '' : `${JSON.stringify(x.dataImmediately)}（${x.sameMicroVmImmediately} / ${x.markImmediately}）`} | ${JSON.stringify(x.dataAfterRestart ?? null)}（${x.markAfterRestart ?? ''} / ${x.codeRevAfterRestart ?? ''}） | ${x.wiped ?? ''} |`)
for (const x of rows.filter((r) => r.failedLines?.length || r.resources)) md.push('', `**${x.id}** ${x.resources ? `资源：${x.resources.join('，')}` : ''}`, ...(x.failedLines ?? []).map((l) => `- \`${l.replace(/`/g, "'")}\``))
writeFileSync(join(RESULTS, 'summary.md'), md.join('\n') + '\n')
log('done')

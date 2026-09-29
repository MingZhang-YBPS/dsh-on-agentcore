// preflight / deploy / destroy 共用：命令行解析、CDK context 合并、区域解析、子进程与栈状态查询。

import { CloudFormationClient, DescribeStackEventsCommand, DescribeStacksCommand, ListStackResourcesCommand, type Stack, type StackEvent } from '@aws-sdk/client-cloudformation'
import { App } from 'aws-cdk-lib'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../lib/bundle.js'
import { readParams, readPerUserParams, type Params } from '../lib/params.js'
import { PER_USER_STACK_NAME } from '../lib/per-user-stack.js'
import { STACK_NAME } from '../lib/stack.js'

export { STACK_NAME, PER_USER_STACK_NAME, REPO_ROOT }
export const INFRA_DIR = join(REPO_ROOT, 'infra')
export const CDK_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'cdk')

export interface Cli {
  /** -c/--context key=value（原样转交给 cdk） */
  context: Record<string, string>
  flags: Set<string>
}

export function parseCli(argv: string[], knownFlags: readonly string[]): Cli {
  const context: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '-c' || a === '--context') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq <= 0) fail(`invalid context argument: ${kv} (expected key=value)`)
      context[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (knownFlags.includes(a)) flags.add(a)
    else fail(`unknown argument: ${a}\nknown: -c key=value ${knownFlags.join(' ')}`)
  }
  return { context, flags }
}

export const contextArgs = (cli: Cli): string[] => Object.entries(cli.context).flatMap(([k, v]) => ['-c', `${k}=${v}`])

/** cdk.json 的 context 默认值 + 命令行覆盖 */
export function mergedContext(cli: Cli): Record<string, unknown> {
  const cdkJson = JSON.parse(readFileSync(join(INFRA_DIR, 'cdk.json'), 'utf8')) as { context?: Record<string, unknown> }
  return { ...(cdkJson.context ?? {}), ...cli.context }
}

export const isTrue = (v: unknown): boolean => ['true', '1', 'yes'].includes(String(v ?? 'false').toLowerCase())

/** 目标栈：-c stack=DshPoc（默认，共享 Runtime）或 -c stack=DshPerUser（每用户 Runtime + EFS） */
export function stackNameOf(cli: Cli): string {
  const s = String(mergedContext(cli).stack ?? STACK_NAME)
  if (s !== STACK_NAME && s !== PER_USER_STACK_NAME) fail(`context stack must be ${STACK_NAME} or ${PER_USER_STACK_NAME}`)
  return s
}
export const isPerUser = (stackName: string): boolean => stackName === PER_USER_STACK_NAME

export function loadParams(cli: Cli, region: string): Params {
  const app = new App({ context: mergedContext(cli), autoSynth: false })
  const p = readParams(app.node, region)
  if (isPerUser(stackNameOf(cli))) readPerUserParams(app.node, region, p)
  return p
}

export async function resolveRegion(): Promise<string> {
  const r = await new CloudFormationClient({}).config.region()
  if (!r) fail('no AWS region configured (set AWS_REGION or a profile region)')
  return r
}

export function fail(msg: string, code = 1): never {
  console.error(`ERROR: ${msg}`)
  process.exit(code)
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {}): { done: Promise<{ code: number; out: string }>; kill: () => void } {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? INFRA_DIR, env: opts.env ?? process.env, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8') })
  const done = new Promise<{ code: number; out: string }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), out }))
  })
  return { done, kill: () => { child.kill('SIGTERM') } }
}

export async function describeStack(cfn: CloudFormationClient, name = STACK_NAME): Promise<Stack | undefined> {
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: name }))
    return r.Stacks?.[0]
  } catch (e) {
    if (/does not exist/.test((e as Error).message)) return undefined
    throw e
  }
}

export const outputOf = (s: Stack | undefined, key: string): string | undefined => s?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue

/** 栈的全部嵌套栈（每用户部署：每名用户一个），返回其 describe-stacks 结果 */
export async function nestedStacks(cfn: CloudFormationClient, name: string): Promise<Stack[]> {
  const ids: string[] = []
  let token: string | undefined
  do {
    const r = await cfn.send(new ListStackResourcesCommand({ StackName: name, NextToken: token }))
    for (const x of r.StackResourceSummaries ?? []) if (x.ResourceType === 'AWS::CloudFormation::Stack' && x.PhysicalResourceId) ids.push(x.PhysicalResourceId)
    token = r.NextToken
  } while (token)
  const out: Stack[] = []
  for (const id of ids) { const s = await describeStack(cfn, id); if (s) out.push(s) }
  return out
}

/** 返回 since 之后的栈事件（按时间正序） */
export async function eventsSince(cfn: CloudFormationClient, since: Date, name = STACK_NAME): Promise<StackEvent[]> {
  const out: StackEvent[] = []
  let token: string | undefined
  for (let page = 0; page < 20; page++) {
    const r = await cfn.send(new DescribeStackEventsCommand({ StackName: name, NextToken: token }))
    const evs = r.StackEvents ?? []
    for (const e of evs) if (e.Timestamp && e.Timestamp >= since) out.push(e)
    const last = evs[evs.length - 1]
    if (!r.NextToken || !last?.Timestamp || last.Timestamp < since) break
    token = r.NextToken
  }
  return out.reverse()
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const ts = (): string => new Date().toISOString().slice(11, 19)

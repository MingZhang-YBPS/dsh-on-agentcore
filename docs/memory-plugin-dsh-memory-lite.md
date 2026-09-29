# 给单个用户安装记忆插件 dsh-memory-lite（DshPerUser 栈）

本文说明如何只给 `DshPerUser` 栈中的某一名用户（下文以 `bob` 为例）安装社区记忆插件 [`@alanzhao/dsh-memory-lite`](https://www.npmjs.com/package/@alanzhao/dsh-memory-lite) 0.3.0。安装不改动仓库代码与栈模板，也不影响其他用户。2026-09-29 在 bob 上实测通过：插件在回合结束后自动提取记忆；新会话、以及回收 microVM 之后，模型都能召回。

## 背景

- **插件装在哪里。** DSH 的插件装在 profile 目录 `$DSH_HOME/profiles/web` 里：`dsh plugin --profile web add <包>` 调用 pnpm 安装，并把包加进 profile 清单的 `dsh.profile.bundles`。每用户 Runtime 的 `DSH_HOME` 是 `/mnt/workspace/.dsh`，在该用户自己的 EFS 上，所以插件装一次就一直有效。回收 microVM、Runtime 升级都不会丢。
- **为什么要借一个临时 Runtime。** microVM 里没有 pnpm；用户自己的 microVM 里还跑着 DSH，边跑边改 profile 不安全。所以另建一个临时 Runtime：
  - 它用该用户的执行角色、同一个 EFS 访问点、同一组子网和安全组，因此只能访问这名用户的文件系统；
  - 由它执行安装，装完即删。
- **必须把 `@deepseek-ai/schemastery` 固定到 DSH 宿主的版本。** 这个插件依赖 schemastery，pnpm 会往 profile 里装一份 3.18.4，而 DSH 0.1.5-rc.3 宿主用的是 3.18.2。两份版本同时存在时，Cordis 会把插件的每一项配置都解析成空对象，DSH 启动失败，报错 `path.startsWith is not a function`，页面打不开。解决办法是在 profile 的 `pnpm-workspace.yaml` 里用 `overrides` 把它钉到宿主版本。其他插件如果也带了 schemastery，同样需要这一步。
- **插件的默认触发条件要调整。** 默认要新增 50 条消息，或者空闲 30 分钟才提取一次，但 microVM 空闲 15 分钟就被回收，空闲触发永远等不到。下面的补丁打开「回合结束时提取」，从 2 条消息起就提取，防抖 5 秒，空闲兜底改为 10 分钟。
- **插件的设置页保存不了。** 适配器只放行固定的几个设置命名空间（`services/adapter/src/rpc-guard.ts`），`memory-lite` 不在其中。它的参数只能通过 profile 补丁修改。
- **记忆存放位置与费用。** 记忆写在 `~/.agent-memory`（EFS 上的 `/mnt/workspace/.agent-memory`），是纯 Markdown。每次提取调用一次该用户的默认模型，费用计入对应的 DeepSeek key，或者 Bedrock。
- **插件是个人维护的。** 运行在 DSH 进程里，能读到该用户的会话与文件。版本要锁定，升级前重新审查。

## 前置条件

- 已部署 `DshPerUser`，目标用户已在 `demoUsers` 中。
- 本机执行过 `npm run build:adapter`，即存在 `~/.cache/dsh-poc/adapter-build/pkg`，其中是锁定版本的 DSH（arm64）。
- 本机有 AWS CLI、Node.js ≥ 22、`zip`、`python3`，凭证能创建 AgentCore Runtime、读写 CDK 资产桶。

## 1. 准备安装任务的代码包

```bash
set -euo pipefail
W=/tmp/dsh-plugin-job && rm -rf "$W" && mkdir -p "$W"
cp -a ~/.cache/dsh-poc/adapter-build/pkg "$W/pkg"            # 锁定版本的 DSH（与用户 Runtime 相同）
(cd "$W" && npm pack pnpm@10.34.6 --silent >/dev/null && mkdir -p pkg/admin-pnpm && tar xzf pnpm-10.34.6.tgz -C pkg/admin-pnpm)
# AgentCore 拒绝含非 linux/arm64 二进制的代码包：删掉 pnpm 自带的其他平台 reflink 与 Windows 可执行文件
rm -f "$W"/pkg/admin-pnpm/package/dist/reflink.*.node "$W"/pkg/admin-pnpm/package/dist/vendor/fastlist-*.exe
```

把下面的脚本保存为 `$W/pkg/admin-job.js`。AgentCore 的 `NODE_22` 运行时要求入口是 `.js` 文件；包内 `package.json` 已声明 `"type": "module"`，所以这里可以直接写 ESM。

```js
// 一次性运维任务：在临时 Runtime 里用目标用户的执行角色与 EFS 访问点，安装或卸载 profile 插件。
// 调用时的请求体：{"action":"install"} 或 {"action":"uninstall"}
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = dirname(fileURLToPath(import.meta.url))
const yaml = createRequire(import.meta.url)('js-yaml')
const MOUNT = process.env.JOB_MOUNT || '/mnt/workspace' // JOB_MOUNT 仅用于本机演练
const DSH_HOME = join(MOUNT, '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const DSH_BIN = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PLUGIN = '@alanzhao/dsh-memory-lite'
const VERSION = '0.3.0'
const ENTRY_ID = 'memory-lite'
const ENTRY_CONFIG = {
  extraction: { mode: 'incremental', turnStoppingTrigger: true, flushTrigger: true, minTurnExtract: 2, turnDebounceMs: 5000, idleTimeoutMin: 10 },
}
const HOST_SCHEMASTERY = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'), 'utf8')).version

const mounted = () =>
  !!process.env.JOB_MOUNT ||
  readFileSync('/proc/mounts', 'utf8')
    .split('\n')
    .some((l) => l.split(' ')[1] === MOUNT)
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)

async function job(action) {
  const log = { action, hostSchemastery: HOST_SCHEMASTERY }
  const t0 = Date.now()
  while (!mounted() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100)) // AgentCore 先启动进程、后挂载 EFS
  mkdirSync('/tmp/bin', { recursive: true })
  writeFileSync('/tmp/bin/pnpm', `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'admin-pnpm', 'package', 'bin', 'pnpm.cjs')}" "$@"\n`)
  chmodSync('/tmp/bin/pnpm', 0o755)
  const env = {
    ...process.env,
    DSH_HOME,
    HOME: '/tmp/adminhome',
    PATH: `/tmp/bin:${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    npm_config_store_dir: '/tmp/pnpm-store',
    CI: '1',
  }
  mkdirSync(env.HOME, { recursive: true })
  const dsh = (args) => {
    const r = spawnSync(process.execPath, [DSH_BIN, ...args], { cwd: '/tmp', env, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 })
    return { code: r.status, out: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2000) }
  }
  // profile 不存在时由 dsh plugin 初始化；先确保 schemastery 与宿主共用同一版本
  if (!existsSync(join(PROFILE, 'package.json'))) log.init = dsh(['plugin', '--profile', 'web', 'list'])
  const ws = join(PROFILE, 'pnpm-workspace.yaml')
  let wsText = read(ws) ?? 'packages:\n  - .\n'
  if (!/^overrides:/m.test(wsText))
    wsText =
      wsText.replace(/\s*$/, '\n') +
      `\n# 与 DSH 宿主共用同一份 schemastery（两份版本会让 Cordis 把插件配置解析成空对象）\noverrides:\n  '@deepseek-ai/schemastery': ${HOST_SCHEMASTERY}\n`
  writeFileSync(ws, wsText)

  log.pnpm = action === 'uninstall' ? dsh(['plugin', '--profile', 'web', 'rm', PLUGIN]) : dsh(['plugin', '--profile', 'web', 'add', `${PLUGIN}@${VERSION}`])

  // profile 自己的补丁层：写入（或删除）插件的配置行，先备份
  const patchFile = join(PROFILE, 'cordis.patch.yml')
  if (existsSync(patchFile)) copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
  let entries = yaml.load(read(patchFile) ?? '[]') ?? []
  if (!Array.isArray(entries)) throw new Error('profile cordis.patch.yml is not a YAML array')
  entries = entries.filter((e) => e?.id !== ENTRY_ID)
  if (action !== 'uninstall') entries.push({ id: ENTRY_ID, config: ENTRY_CONFIG })
  writeFileSync(patchFile, '# Profile patch layer (plugin rows managed by the admin job)\n' + yaml.dump(entries))
  log.manifest = read(join(PROFILE, 'package.json'))
  log.patch = read(patchFile)

  // 按适配器的方式试启动 dsh web（模型地址指向不存在的端口，只看插件树能否加载），成功后立即结束
  const bootEnv = {
    PATH: env.PATH,
    LANG: 'C.UTF-8',
    HOME: MOUNT,
    DSH_HOME,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_BRIDGE_MODEL_ID: 'deepseek.v3.2',
    DSH_BRIDGE_MODEL_BASE_URL: 'http://127.0.0.1:9/openai/v1',
    DSH_BRIDGE_PLACEHOLDER_KEY: 'x',
    DSH_BRIDGE_DEEPSEEK_API_BASE: 'http://127.0.0.1:9',
    DSH_BRIDGE_DEFAULT_PROVIDER: 'deepseek-official',
    DSH_BRIDGE_DEFAULT_MODEL: 'deepseek-flash',
    DSH_BRIDGE_DEEPSEEK_KEY: 'x',
  }
  mkdirSync(join(MOUNT, 'workspace'), { recursive: true })
  let out = ''
  const child = spawn(
    process.execPath,
    [
      DSH_BIN,
      '--profile',
      'web',
      '--patch',
      join(ROOT, 'dsh', 'web.cordis.yml'),
      '--patch',
      join(ROOT, 'dsh', 'web-hardening.cordis.yml'),
      '--port',
      '3999',
      '--no-open',
    ],
    { cwd: join(MOUNT, 'workspace'), env: bootEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })
  log.bootOk = await new Promise((r) => {
    const t = setTimeout(() => r(false), 60000)
    const iv = setInterval(() => {
      if (/http:\/\/127\.0\.0\.1:3999\/\?token=/.test(out)) {
        clearTimeout(t)
        clearInterval(iv)
        r(true)
      }
    }, 200)
    child.on('exit', () => {
      clearTimeout(t)
      clearInterval(iv)
      r(false)
    })
  })
  if (!log.bootOk) log.bootOut = out.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(-3000)
  if (child.exitCode === null) child.kill('SIGTERM')
  log.ms = Date.now() - t0
  return log
}

let result = null
http
  .createServer((req, res) => {
    if (req.url === '/ping') {
      res.end(JSON.stringify({ status: 'Healthy' }))
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', async () => {
      let action = 'install'
      try {
        action = JSON.parse(body || '{}').action === 'uninstall' ? 'uninstall' : 'install'
      } catch {}
      try {
        result ??= await job(action)
      } catch (e) {
        result = { error: String(e?.stack || e) }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result, null, 1))
    })
  })
  .listen(8080, '0.0.0.0')
```

打包并上传到 CDK 资产桶。用户的执行角色已经有这个桶的读权限，那是它读取自己代码包用的：

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text); REGION=$(aws configure get region)
BUCKET=cdk-hnb659fds-assets-$ACCOUNT-$REGION
(cd "$W/pkg" && node --check admin-job.js && zip -qr ../job.zip .)
aws s3 cp "$W/job.zip" "s3://$BUCKET/dsh-admin/job.zip"
```

## 2. 取目标用户 Runtime 的角色、访问点与网络配置

```bash
USER_NAME=bob
NS=$(aws cloudformation list-stack-resources --stack-name DshPerUser \
  --query "StackResourceSummaries[?ResourceType=='AWS::CloudFormation::Stack'].PhysicalResourceId" --output text | tr '\t' '\n' \
  | while read -r s; do [ "$(aws cloudformation describe-stacks --stack-name "$s" --query "Stacks[0].Outputs[?OutputKey=='Username'].OutputValue" --output text)" = "$USER_NAME" ] && echo "$s"; done)
USER_RT=$(aws cloudformation describe-stacks --stack-name "$NS" --query "Stacks[0].Outputs[?OutputKey=='AgentRuntimeArn'].OutputValue" --output text)
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${USER_RT##*/}" \
  --query '{role:roleArn,net:networkConfiguration,fs:filesystemConfigurations}' --output json > "$W/user.json"
cat "$W/user.json"
```

## 3. 回收该用户的 microVM

先回收，避免安装期间正在运行的 DSH 读到改了一半的 profile。每用户 Runtime 的授权器只接受该用户自己的令牌，所以用他的口令换取令牌：

```bash
stop_user_session() {
  local po; po=$(aws cloudformation describe-stacks --stack-name DshPerUser --query 'Stacks[0].Outputs' --output json)
  local pool client secret pw tok sub
  pool=$(echo "$po" | python3 -c "import json,sys;print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='UserPoolId'][0])")
  client=$(echo "$po" | python3 -c "import json,sys;print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='UserPoolClientId'][0])")
  secret=$(aws cloudformation describe-stacks --stack-name "$NS" --query "Stacks[0].Outputs[?OutputKey=='UserSecretArn'].OutputValue" --output text)
  pw=$(aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text)
  tok=$(aws cognito-idp admin-initiate-auth --user-pool-id "$pool" --client-id "$client" --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "$(python3 -c "import json,sys;print(json.dumps({'USERNAME':sys.argv[1],'PASSWORD':sys.argv[2]}))" "$USER_NAME" "$pw")" \
    --query AuthenticationResult.AccessToken --output text)
  sub=$(python3 -c "import base64,json,sys;p=sys.argv[1].split('.')[1];print(json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4)))['sub'])" "$tok")
  curl -s -o /dev/null -w "StopRuntimeSession %{http_code}\n" -X POST \
    "https://bedrock-agentcore.$REGION.amazonaws.com/runtimes/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$USER_RT")/stopruntimesession?qualifier=DEFAULT" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' -H "x-amzn-bedrock-agentcore-runtime-session-id: dsh-user-$sub" -d '{}'
}
stop_user_session      # 200，或 404（会话已被回收）都可以
```

如果用户开着页面，页面会立即重连，microVM 随之重新启动。这不影响安装，但插件要到第 5 步再回收一次之后才会加载。

## 4. 创建临时 Runtime 并执行安装

```bash
ROLE=$(python3 -c "import json;print(json.load(open('$W/user.json'))['role'])")
NET=$(python3 -c "import json;n=json.load(open('$W/user.json'))['net']['networkModeConfig'];print(json.dumps({'networkMode':'VPC','networkModeConfig':{'securityGroups':n['securityGroups'],'subnets':n['subnets']}}))")
FS=$(python3 -c "import json;print(json.dumps(json.load(open('$W/user.json'))['fs']))")
JOB_ARN=$(aws bedrock-agentcore-control create-agent-runtime --agent-runtime-name "dsh_pu_admin_${USER_NAME//-/_}" \
  --agent-runtime-artifact "{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"dsh-admin/job.zip\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"admin-job.js\"]}}" \
  --role-arn "$ROLE" --network-configuration "$NET" --protocol-configuration serverProtocol=HTTP --filesystem-configurations "$FS" \
  --query agentRuntimeArn --output text)
until s=$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${JOB_ARN##*/}" --query status --output text); [[ $s == READY || $s == *FAILED ]]; do sleep 5; done; echo "$s"
aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn "$JOB_ARN" --runtime-session-id "admin-$USER_NAME-plugin-install-00000000001" \
  --payload '{"action":"install"}' --cli-binary-format raw-in-base64-out --cli-read-timeout 900 "$W/out.json" --query statusCode
python3 -c "import json;d=json.load(open('$W/out.json'));print(d.get('bootOk'), d.get('error','')); print(d.get('manifest')); print(d.get('patch'))"
```

成功时 `bootOk` 为 `true`；profile 清单的 `dsh.profile.bundles` 里有 `@alanzhao/dsh-memory-lite`；补丁里有 `memory-lite` 那一行。`bootOk` 为 `false` 时，看 `bootOut` 里的启动错误，**不要**继续回收用户的 microVM，否则该用户的页面会打不开。可以用 `{"action":"uninstall"}` 回退。

清理临时资源：

```bash
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "${JOB_ARN##*/}"
aws s3 rm "s3://$BUCKET/dsh-admin/job.zip"
sleep 30; for g in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/dsh_pu_admin --query 'logGroups[].logGroupName' --output text); do aws logs delete-log-group --log-group-name "$g"; done
```

临时 Runtime 的名称以 `dsh_pu_` 开头，`npm run destroy:per-user` 清理日志组时也会带上它们。

## 5. 让插件生效并验证

```bash
stop_user_session
```

在该用户的 Runtime 日志（`/aws/bedrock-agentcore/runtimes/<Runtime ID>-DEFAULT`）中应能看到 `dsh web ready`，不应出现 `dsh exited unexpectedly`。bob 实测从启动到就绪约 8.6 s，比装插件前多 1 秒多。

以该用户登录后验证：

1. 在对话里介绍几条稳定的个人信息（例如项目名、常用语言），不要求模型「记住」。回合结束约 5 秒后，适配器日志里会多一条模型调用，这就是插件的后台提取。
2. 新建会话，问「我在做的那个项目叫什么？」模型应当答对。
3. 再回收一次 microVM（`stop_user_session`），重新打开后再问一次，仍应答对：记忆在 EFS 上。

## 回退

用同一个任务包，把请求体换成 `{"action":"uninstall"}` 执行第 4 步，再执行第 5 步的回收。卸载只移除插件与补丁行，`~/.agent-memory` 里已有的记忆文件保留。要删除它们，可以在该用户的 DSH 终端里执行 `rm -rf ~/.agent-memory`。

## 在 bob 上的现状（2026-09-29）

- 已安装 `@alanzhao/dsh-memory-lite@0.3.0`，schemastery 固定为 3.18.2，补丁如上。
- 之前试装过 `dsh-memory-eternal` 0.7.0，已卸载。它读取 `agent.session.events` 做自动记忆，而 DSH 从 0.1.2 起已移除这个属性，所以在 0.1.5-rc.3 上自动记忆不会触发。它的记忆库目录 `/mnt/workspace/.dsh/memory-vault` 仍保留在 bob 的 EFS 上。
- 提取那次模型调用在适配器日志中标记为 `cancelled: true`，但记忆已写入。可能是插件读到结果后主动断开了流，尚未深究。

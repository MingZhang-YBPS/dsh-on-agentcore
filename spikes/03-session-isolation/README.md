# Spike 03：会话级工作空间隔离的凭证机制验证

对应 tasks.md 任务 1.3（Requirements 1.9、5.5、5.6）。结论已回写 `.kiro/specs/poc/design.md`：「请求路径与职责边界」、第 5 节「会话隔离」、Property 25、CDK 构件划分。

## 验证内容

1. AgentCore Runtime 执行角色凭证能否携带 `${aws:PrincipalTag/sessionId}`：执行角色挂上以该变量限定的 S3/DynamoDB 权限，信任策略额外放开 `sts:TagSession`，看 microVM 内能否访问本会话前缀；再从 CloudTrail 读 AgentCore 扮演执行角色时的 `AssumeRole` 请求参数。
2. 替代方案「接入服务带会话标签 AssumeRole 工作空间角色，把会话限定凭证随调用传入 microVM」：用会话 A 的凭证对 A、B 两个会话做读、写、列举、删除、复制、DynamoDB 读写、再次 AssumeRole，本机与 microVM 内各跑一遍。
3. 信任策略条件的边界：标签值、标签键、有效期。
4. microVM 内子进程（模拟 DSH 工具进程）拿到的默认凭证是什么。

## 运行

依赖：bash、aws CLI v2、Node.js ≥ 22、npm、python3（仅生成 UUID）、zip。区域取自 `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure`。不需要 Docker：探针用 AgentCore 的 NODE_22 直接代码部署（esbuild 打成单个 `app.js`，zip 上传 S3）。

```bash
./run-all.sh          # 创建 → 用例 → 清理 → 拉 CloudTrail（EXIT trap 保证清理），约 5 分钟
# 或分步执行
./setup.sh
node src/run_tests.mjs      # → results/cases.jsonl、runtime-probe-{A,B}.json、mint-latency.json、summary.md
./cleanup.sh
node src/cloudtrail.mjs     # 需要 .state/state.env；run-all.sh 用清理前的副本调用 → results/cloudtrail-assumerole.jsonl
```

创建的资源（均带 `dsh-poc-spike-03-` 前缀或 `dsh_poc_spike_03_probe` 名称，tag `purpose=dsh-poc-spike-03`）：

| 资源 | 用途 |
|---|---|
| S3 桶 `dsh-poc-spike-03-{account}-{region}` | `code/probe.zip` 与 `workspaces/{sessionId}/seed.txt` |
| DynamoDB 表 `dsh-poc-spike-03-table` | `WORKSPACE#{id}/HEAD`、`SESSION#{id}/RUNCTL` |
| IAM 角色 `…-exec-role` | AgentCore 执行角色，挂 `${aws:PrincipalTag/sessionId}` 限定的工作空间权限 |
| IAM 角色 `…-gateway-sim-role` | 模拟接入服务 Lambda 角色（只信任运行脚本的 IAM 身份） |
| IAM 角色 `…-workspace-role` | 工作空间访问角色，权限同上，只能由 gateway-sim 带 `sessionId` 标签扮演 |
| AgentCore Runtime `dsh_poc_spike_03_probe` 及其日志组 | 探针（`GET /ping`、`POST /invocations`） |

策略文档全部在 `src/policies.mjs`。`cleanup.sh` 按名称与 `.state/state.env` 双重定位删除，可重复执行。会话限定凭证只存在于进程内存与 `InvokeAgentRuntime` 请求体中，结果文件不含凭证。

## 实测结果（us-east-1，2026-09-26，临时资源已删除并核实）

127 个用例全部符合预期。完整表格见 `results/summary.md`。

**执行角色不带会话标签**

| 证据 | 观察 |
|---|---|
| E02–E04（microVM 内，默认凭证） | 执行角色挂着 `workspaces/${aws:PrincipalTag/sessionId}/*` 与 `WORKSPACE#${aws:PrincipalTag/sessionId}` 的权限，访问本会话前缀仍然 `AccessDenied`：策略变量无值，语句不匹配 |
| CloudTrail（`cloudtrail-assumerole.jsonl`） | 4 条执行角色 `AssumeRole`（创建 Runtime 时 2 条，两次会话调用各 1 条），`invokedBy=bedrock-agentcore.amazonaws.com`，请求参数只有 `roleArn`、`roleSessionName`、`durationSeconds`，没有 `tags`、`transitiveTagKeys`、`sourceIdentity`。阳性对照：工作空间角色的 15 条 `AssumeRole` 全部记录了 `tags` |
| 角色会话名 | `BedrockAgentCore-{uuid}`，每个 Runtime 会话不同，但与调用方的 `runtimeSessionId` 无关，无法用 `aws:userid` 做前缀映射 |
| 官方信任策略模板 | 只有 `sts:AssumeRole`，没有 `sts:TagSession` |

**microVM 内的默认凭证对所有进程开放**

- 子进程（E06）经默认凭证链拿到的身份与适配层完全相同。容器环境变量里没有任何凭证类变量，SDK 从凭证端点取得（具体端点未单独验证）。因此 DSH 执行的任何 shell 工具都能使用执行角色的全部权限。
- 容器收到 `x-amzn-bedrock-agentcore-runtime-session-id` 请求头，值与调用方传入的 `runtimeSessionId` 一致（E07）。其余请求头：`accept`、`baggage`、`content-length`、`content-type`、`host`、`x-amzn-requestid`、`x-amzn-trace-id`。
- 探针环境：Node v22.23.2、arm64、uid 991。冷启动调用 3.1–4.5 s（含两组矩阵各约 30 次 AWS 调用）。

**接入服务铸造的会话限定凭证（本机与 microVM 内结果一致）**

| 用例 | 结果 |
|---|---|
| M01–M04 本会话 Get / Put / List(prefix=本会话/) / Delete | 允许 |
| M05–M11 对端 Get / Put / List(prefix=对端/) / List(prefix=workspaces/) / List(无 prefix) / Delete / Copy | 全部 `AccessDenied` |
| M12 Get `workspaces/A/../B/seed.txt` | `NoSuchKey`：S3 按字面量处理点段，没有穿越 |
| M13 Put `workspaces/A/../B/traversal.txt` | 写入成功，但对象的字面量键仍在 A 前缀下（P01、P03 核实 B 前缀下没有此对象） |
| M14 Get `workspaces/A/%2e%2e/B/seed.txt` | `NoSuchKey`（字面量） |
| M15、M16、M20 本会话 HEAD 读 / 条件更新，本会话 RUNCTL 读 | 允许 |
| M17–M19、M21、M23 对端 HEAD 读 / 更新 / Put，对端 RUNCTL 读，Query 对端分区 | 全部 `AccessDeniedException` |
| M22 Put 本会话 RUNCTL | `AccessDeniedException`（适配层对 RUNCTL 只读） |
| M24 Scan | `AccessDeniedException` |
| M25 用会话 A 凭证再 AssumeRole 工作空间角色并打 B 标签 | `AccessDenied` |
| P02 事后核对 HEAD.version | 两个会话都是 3（初始 1 + 本机与 microVM 各一次 M16），没有被对端改为 999 |

**信任策略条件边界**

| 用例 | 结果 |
|---|---|
| T01 标签值 `*` | STS `ValidationError`（标签值字符集不含 `*`），通配无从注入 |
| T02 不带标签 | `AccessDenied`：`aws:RequestTag/sessionId` 条件同时作用在 `sts:AssumeRole` 上 |
| T03 标签值 `{B}/../x`、T04 多一个 `userId` 标签键、T08 键名写成 `SessionId` | `AccessDenied`（`sts:TagSession`） |
| T05 / T06 `DurationSeconds` 3600 / 3601 | 允许 / `ValidationError`（超过角色 `MaxSessionDuration`；角色链本身也限 1 小时） |
| T07 `zzzzzzzz-zzzz-…`（UUID 形态但非十六进制） | 允许：`StringLike` 只校验形态，sessionId 的合法性要由接入服务保证 |

**凭证铸造耗时**：本机（WSL）→ STS `AssumeRole` 10 次，P50 308 ms，最大 616 ms。Lambda 同区域调用预计更低，未在 Lambda 上测量。

## 结论

- AgentCore Runtime 扮演执行角色时不传会话标签，执行角色凭证不能携带 `${aws:PrincipalTag/sessionId}`。design.md 原「执行角色 S3 策略用 PrincipalTag 限定前缀」不成立。
- 执行角色凭证对 microVM 内所有进程开放，DSH 工具可以直接使用。因此只要执行角色本身拥有工作空间桶或表的访问权，「适配层前缀校验」就挡不住工具进程；microVM 内自行 AssumeRole 限定权限同理（工具可以用执行角色重新铸造任意会话的凭证）。
- 选定方案：**接入服务（microVM 外、可信）在授权通过后带 `sessionId` 会话标签 AssumeRole 工作空间角色，把 1 小时有效的会话限定凭证随 `InvokeAgentRuntime` 请求体传给适配层；执行角色不授予任何工作空间 S3 / DynamoDB 权限。** 会话 A 的凭证对会话 B 的读、写、列举、删除、再铸造全部被 IAM 拒绝，本机与 microVM 内一致。适配层前缀校验保留为第二道防线。
- 不选「接入服务授权 + 适配层前缀校验作为 PoC 安全边界」：执行角色必须拥有整个工作空间桶的权限，任何会话里的工具进程都能读写所有会话，不满足 5.5/5.6。
- S3 不规范化键中的 `..`，穿越写入只会落在本会话前缀下的字面量键上；但工作空间管理器解包时若用 `path.join` 之类的函数处理这种键，可能写到 `/workspace` 之外，所以 `resolveKey` 与快照编解码仍须拒绝 `..` 段（与 5.8、Property 25 一致）。

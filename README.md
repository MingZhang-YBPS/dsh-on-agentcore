# DSH on AgentCore（PoC）

把官方 DeepSeek Harness Web UI（`@deepseek-ai/dsh` 0.1.5-rc.3 的 `dsh web`）运行在 Amazon Bedrock AgentCore Runtime 上：**每个用户一个运行时会话（microVM）**，会话历史、设置与工作空间文件保存在该会话的 session storage 里。

模型有两个来源，用户在输入框下方的模型下拉里切换：
- **DeepSeek 官方**（部署配置了 DeepSeek API key 时为默认）：DeepSeek-V4.1-Flash（默认）、DeepSeek-V4-Pro；
- **Amazon Bedrock**：`deepseek.v3.2`（OpenAI 兼容接口，SigV4 签名）。

```
浏览器 ──HTTPS──▶ CloudFront ─┬─ 默认 / /plugins/* ─▶ 隧道 Lambda（登录、cookie 令牌、续期）─InvokeAgentRuntime─┐
                              └─ /api/remote.mux ───▶ AgentCore /ws（CloudFront Function 注入 Bearer）─────────┤
                                                                                                                ▼
                                           AgentCore Runtime（JWT 授权器，会话 ID = dsh-user-<Cognito sub>）
                                           └─ microVM：适配器（会话归属校验、封包、WebSocket 分片、DSH_HOME 镜像、设置过滤、本地代理）
                                                       └─ dsh web（补丁）─┬─▶ SigV4 签名代理 ──▶ Bedrock deepseek.v3.2
                                                                          └─▶ DeepSeek 代理（注入 key）──▶ api.deepseek.com（对话、网页搜索）
```

需求、设计与任务见 `.kiro/specs/poc/`；技术验证记录见 `spikes/01–09`。

## 部署

前置：Node.js ≥ 22.12、AWS CLI 与凭证（部署账号需能创建 IAM、Cognito、Lambda、CloudFront、AgentCore 等资源）、目标区域已 `cdk bootstrap`、Bedrock 中已开通所选模型。构建代码包需要 `zip`、`file`。

```bash
npm ci
npm run preflight                        # 参数、凭证、CDK bootstrap、模型可用性（1 token 实际调用），30 秒硬超时
npm run deploy                           # preflight → 构建 arm64 代码包 → 数据清空保护 → cdk deploy（约 5 分钟，主要是 CloudFront）
npm run destroy -- --confirm-delete-user-data   # 删除全部资源（含所有用户数据），并清理服务自动创建的日志组
```

部署完成后输出 `WebUrl` 与每个用户口令所在的 Secret：

```bash
aws secretsmanager get-secret-value --secret-id <UserSecretdemo 的 ARN> --query SecretString --output text
```

用用户名（默认 `demo`）和该口令在 `WebUrl` 登录。`ops` 是运维用户，只用于需要 Bearer 令牌的数据面调用（`StopRuntimeSession`）。

### DeepSeek 官方 API key（对话模型与网页搜索）

DeepSeek 官方模型与网页搜索都使用 DeepSeek（api.deepseek.com）的 API key。部署时通过环境变量传入（不要用 `-c`，context 会写进 `cdk.out`）：

```bash
read -rs DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY   # 避免 key 进入 shell 历史
npm run deploy                                         # preflight 先用它调用一次 api.deepseek.com/models 校验
```

- key 存入栈里的 secret（输出 `DeepSeekApiKeySecretArn`），不进入模板、Runtime 配置或 DSH 的配置、设置文件与环境。
- 设置或更换 key 不改动 Runtime，不会清空数据。之后启动的 microVM 立即使用；已运行的 microVM 5 分钟内生效。「是否配置了 key」在 microVM 启动时确定：从无到有配置 key 后，DeepSeek 官方模型、默认模型与插件页的「已配置密钥」要等各用户的 microVM 回收后才出现。
- 不传 `DEEPSEEK_API_KEY` 时保留已存的 key；从未设置时只有 Bedrock 模型，网页搜索不可用，插件页显示「未配置密钥」。
- DeepSeek 官方模型的对话内容会发到 DeepSeek，费用计入该 key 所属账户。
- 也可以直接改 secret：`aws secretsmanager put-secret-value --secret-id <DeepSeekApiKeySecretArn> --secret-string <key>`。

参数都通过 CDK context 传入（`-c key=value`，默认值见 `infra/cdk.json`），常用的有：

| 参数 | 默认 | 说明 |
|---|---|---|
| `demoUsers` | `demo` | 逗号分隔的用户名；增删用户不影响 Runtime |
| `modelId` / `modelRegion` / `modelEndpointSurface` | `deepseek.v3.2` / 部署区域 / `bedrock-runtime` | 模型；`bedrock-mantle` 端点面也可用 |
| `tokenValidityHours` / `refreshTokenValidityDays` | `12` / `1` | 访问令牌与刷新令牌有效期；隧道在令牌剩余不足 5 分钟时自动续期 |
| `idleRuntimeSessionTimeoutSeconds` / `maxLifetimeSeconds` | `900` / `28800` | microVM 空闲回收与最长存活时间 |
| `acceptDataWipe` | `false` | 本次部署会改动 Runtime 时必须显式设为 `true`（见下） |
| `mockModel` | `false` | 测试部署：容器内使用模拟模型 |

## 数据会在什么时候被清空

用户数据（DSH 会话历史、设置、工作空间文件）只存在于该用户运行时会话的 session storage（`/mnt/workspace`）中。以下情况会清空：

1. **Runtime 的任何变更。** 包括升级适配器或 DSH、改环境变量或生命周期参数，甚至只改 Runtime 的描述或标签（Spike 08）。任何这类变更都会产生新的 Runtime 版本，并清空**所有用户**的数据。`npm run deploy` 在 `cdk diff` 中发现 Runtime 变更时会拒绝部署（退出码 3），除非加上 `-c acceptDataWipe=true`。参数不变的重复部署报告 `(no changes)`，不会清空。
2. **清空是惰性的。** 部署成功后，仍在运行的 microVM 继续使用旧版本和旧数据，直到被回收（空闲 15 分钟、最长 8 小时、或 `StopRuntimeSession`）。之后再访问，拿到的才是新版本和空的文件系统。所以部署成功不代表用户已经看到数据丢失，丢失会在之后陆续发生。
3. **14 天未使用。** session storage 在会话 14 天未被调用后由服务清空。
4. **卸载。** `npm run destroy` 删除全部资源和数据。

长期试用前需要改为「每用户一个 Runtime + EFS」（设计决策点 D4），PoC 阶段接受上述行为。方案 A 已实现为独立的栈 `DshPerUser`，见下一节。

## 每用户 Runtime + 独立 EFS（`DshPerUser` 栈）

设计决策点 D4 的方案 A。它是一个**独立的栈**，与 `DshPoc` 可以同时存在，互不影响：两者的 Runtime 名称、用户池、分发、日志组前缀都不同。`npm run deploy` / `destroy`（不带 `:per-user`）仍然只操作 `DshPoc`，模板与之前逐字节相同。

```
浏览器 ─▶ CloudFront ─┬─ 默认 / /plugins/* ─▶ 隧道 Lambda（per-user.ts：查路由表 DynamoDB，下发 dsh_rt cookie）─┐
                      └─ /api/remote.mux ───▶ ws-rewrite-per-user（按 dsh_rt cookie 拼 Runtime ARN）───────────┤
                                                                                                      ▼
                     每名用户：AgentCore Runtime dsh_pu_<用户>（VPC 模式，JWT 授权器要求 username = 该用户）
                               └─ /mnt/workspace = 该用户自己的 EFS 文件系统（访问点，uid/gid 991）
```

```bash
read -rs DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY   # 新栈有自己的 secret，首次部署时要传一次
npm run preflight:per-user
npm run deploy:per-user -- -c demoUsers=alice,bob
npm run destroy:per-user -- --confirm-delete-user-data  # 删除所有用户的 EFS，即全部数据
```

与 `DshPoc` 的区别：

- **数据不随 Runtime 版本丢失。** 数据在各用户的 EFS 上，升级适配器、DSH、改环境变量或生命周期参数都不会清空，也不需要 `acceptDataWipe`。只有 EFS 文件系统被删除或替换时（从 `demoUsers` 去掉用户、卸载）才会删除数据；部署包装器在 `cdk diff` 中发现这种变更时拒绝部署（退出码 3），除非加 `-c acceptDataWipe=true`。
- **没有 1 GB 与 14 天限制；支持硬链接。** DSH_HOME 直接放在 EFS 上，不再镜像（`DSH_HOME_MIRROR=0`），`pnpm` 不需要额外配置。
- **隔离。** 每名用户有自己的执行角色、访问点和文件系统。文件系统策略只允许该用户的角色经 TLS 挂载。Runtime 的 JWT 授权器除 `client_id` 外还要求令牌的 `username` 声明等于所属用户。
- **没有 `ops` 用户。** 每个 Runtime 的授权器只接受其所属用户的令牌，`StopRuntimeSession` 等数据面调用也要用该用户自己的令牌。用户池里的其他用户（没有 Runtime）登录后得到 403。
- **路由。** 「用户名 → Runtime ID」存在 DynamoDB 路由表（输出 `RouteTableName`，由部署写入）。隧道 Lambda 查表（内存缓存 60 秒），并下发 `dsh_rt` cookie（该用户的 Runtime ID，只发往 `/api/remote.mux`）。WebSocket 不经过 Lambda，CloudFront Function 也不能访问 DynamoDB，所以 WebSocket 的目标 Runtime 取自这个 cookie。cookie 被篡改没有用：CloudFront Function 只接受名称与令牌 `username` 一致的 Runtime ID，目标 Runtime 的授权器也会拒绝别人的令牌。cookie 缺失或过期时 WebSocket 返回 403，刷新页面即可重新下发。
- **增删用户要部署一次。** 新用户会新建一个嵌套栈并写入路由表；隧道 Lambda 与 CloudFront Function 都不用改。
- **每名用户一个嵌套栈 `User-<用户名>`。** 嵌套栈里是该用户的 Cognito 用户与口令 secret、执行角色、EFS、Runtime，以及路由项（同时设置 Runtime 日志组的保留期）。主栈里每名用户只占 1 个资源、不占输出，按 CloudFormation 单栈 500 个资源算，大约可以放 440 名用户。
  - 用户多了以后，先碰到的是账号级配额：AgentCore Runtime（默认 1000）、IAM 角色（默认 1000，账号里已有的角色也算）、EFS 文件系统（默认 1000）、CloudFormation 栈数（嵌套栈也算）。
  - 每名用户的 Runtime ARN、EFS ID、口令 secret 在各自嵌套栈的输出上，`deploy:per-user` 结束时会汇总打印。
  - 从 `demoUsers` 去掉用户会删除其嵌套栈，也就删除了该用户的 EFS。部署包装器会把这种变更当作删除数据拦下（退出码 3），除非加 `-c acceptDataWipe=true`。
  - 部署失败时，包装器会把嵌套栈里失败资源的原因一并打印出来。
  - 仪表盘的 Runtime 日志查询只包含前 50 名用户，这是 Logs Insights 的上限。
- **网络与费用。** 新建 VPC（默认 `10.80.0.0/16`），默认**单可用区**：子网按 AgentCore 支持的可用区 ID 创建（us-east-1 默认 `use1-az1`），一个 NAT 网关，每名用户一个 EFS 挂载目标，没有跨可用区流量费。该可用区故障时服务不可用；EFS 用的是区域级（Standard）存储，数据不受影响。传两个可用区时，每个可用区各有一个 NAT。
  - NAT 按小时计费，并收取数据处理费。EFS 按用量计费（Elastic 吞吐，30 天未访问的文件转入 IA）。
  - 私有子网带 S3 网关端点。2026-05 之后新建的 VPC 模式 Runtime 启动时，要经本 VPC 从 S3 下载代码包，这个端点是必需的。
- **卸载可能要重跑。** AgentCore 在 VPC 中创建的网卡会在 Runtime 删除后保留最多 8 小时，其间子网与安全组可能删除失败，稍后再运行一次 `destroy:per-user`。
- 首次在账号中使用 VPC 模式时，AgentCore 会创建服务关联角色 `AWSServiceRoleForBedrockAgentCoreNetwork`，部署身份需要 `iam:CreateServiceLinkedRole`（当前账号还没有这个角色）。

附加参数（`-c key=value`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `vpcCidr` | `10.80.0.0/16` | 必须是 /16，切成 /20：每个可用区一个公有子网放 NAT、一个私有子网放 Runtime 与 EFS 挂载目标 |
| `vpcAzIds` | 区域支持列表的第一个 | 一个或两个可用区 ID，必须在 AgentCore 支持的列表中（`infra/lib/params.ts`）；每个可用区一个 NAT |
| `efsPosixUid` / `efsPosixGid` | `991` / `991` | 访问点的 POSIX 身份，与 NODE_22 代码运行时的进程身份 `agentcore-runtime-user`（991:991，实测）一致 |
| `efsBackup` | `false` | 开启 EFS 自动备份。恢复点在卸载后仍保留，另行计费 |
| `deepseekSecretPerUser` | 空 | 使用自己 DeepSeek 官方 key 的用户，逗号分隔，`*` 表示全部；其余用户共用栈级的 key。见下文「DeepSeek key」 |

**DeepSeek key。** DeepSeek 官方模型与网页搜索用的 key 可以按用户分开；Bedrock 模型仍然用各用户执行角色的 IAM 权限（SigV4）调用，不按用户管理。

- **默认：所有用户共用栈级的 secret。** 输出为 `DeepSeekApiKeySecretArn`，用 `DEEPSEEK_API_KEY` 写入。
- **列在 `deepseekSecretPerUser` 里的用户：** 在自己的嵌套栈里有一个 secret，执行角色只能读自己的，读不到共享的。key 用 `DEEPSEEK_API_KEY_<用户名大写，- 换成 _>` 写入，例如：
  ```bash
  read -rs DEEPSEEK_API_KEY_BOB && export DEEPSEEK_API_KEY_BOB
  npm run deploy:per-user -- -c demoUsers=alice,bob -c deepseekSecretPerUser=bob
  ```
- **key 只经过环境变量。** 值不进 context、模板或 Runtime 配置；preflight 会先调用一次 `api.deepseek.com` 校验每个 key。写入或更换 key 不改动 Runtime；要等各用户的 microVM 回收后（空闲 15 分钟，或用户自己的令牌调用 `StopRuntimeSession`），模型列表里才会出现 DeepSeek 官方模型。
- **在共享与独立之间切换：** 会改变该用户 Runtime 读取的 secret，所以产生新的 Runtime 版本（不丢数据）。新建的独立 secret 初始为 `not-configured`，应在同一次部署里一起传入 key。部署结束时，包装器会逐个用户报告 key 是否已配置。
- 各用户用哪个 secret，见其嵌套栈的输出 `DeepSeekKeyScope`（`user` / `shared`）与 `DeepSeekApiKeySecretArn`。

首次部署实测（2026-09-29，`alice,bob`，全部通过）：

- **隔离：** alice 的令牌调用 bob 的 Runtime，无论 HTTP 还是 WebSocket 都被授权器拒绝（401 `Authorization denied` / 403）。经 CloudFront 把 `dsh_rt` 改成 bob 的 ID、或不带 `dsh_rt`，都由 CloudFront Function 返回 403。
- **EFS：** 容器进程是 uid/gid 991（`agentcore-runtime-user`），与访问点一致。在满足文件系统策略（IAM + TLS）的前提下挂载成功，mkdir、写文件、硬链接都正常。
- **持久化：** 在浏览器里让模型用 bash 写入 `hello.txt`，然后用 alice 自己的令牌调用 `StopRuntimeSession`。重新打开后，会话历史与文件都还在，也能继续对话。
- **冷启动：** 新 microVM 从适配器启动到 DSH 就绪约 6.7 s，首页可用约 14–15 s。
- **跨 Runtime 版本保留数据：** 在 v2 写入 alice、bob 的数据后，两次只改 Runtime 的部署（`idleRuntimeSessionTimeoutSeconds` 900→901→900）把版本推到 v3、v4。每次都回收 microVM 再打开，会话历史与 `hello.txt` 都还在。部署包装器没有拦截（EFS 不受影响），只提示 Runtime 有变更。

部署中发现、已处理的两点：

- **执行角色需要额外权限。** 除 `ClientMount`/`ClientWrite` 外，还需要 `elasticfilesystem:DescribeAccessPoints` 与 `DescribeMountTargets`，否则创建 Runtime 时报「Execution role is missing required filesystem permissions」。文件系统配置文档里没有列出这两项。
- **进程启动时 EFS 还没挂上。** AgentCore 先启动进程，约 0.9 s 后才挂载 EFS。适配器一启动就创建工作区目录，会失败（EACCES）并退出，调用方看到 424「Runtime initialization time exceeded」。
  - 处理办法：每用户 Runtime 的代码包 `adapter-per-user.zip`（`build-adapter.sh` 第 5 步）多一个入口 `per-user-entry.js`，等挂载出现后再加载 `app.js`。
  - `DshPoc` 的 `adapter.zip` 不变。

给单个用户安装 DSH 插件（例如记忆插件 `@alanzhao/dsh-memory-lite`）的步骤见 [`docs/memory-plugin-dsh-memory-lite.md`](docs/memory-plugin-dsh-memory-lite.md)。设计与需求见 `.kiro/specs/poc/design.md` 的「每用户运行时形态（`DshPerUser`）」一节与 `requirements.md` 的需求 8。

端到端脚本 `test/e2e/cloud.ts` 仍针对 `DshPoc`，还没有适配这个栈。

## 已知限制

- **session storage 上限 1 GB。** 大型仓库或依赖安装可能写满。
- **不支持硬链接。** DSH_HOME 因此在本地盘运行、每 2 秒镜像到 session storage（回收时做最终同步）。工作区里 `npm`、`pip` 可以正常使用；`pnpm` 需设置 `package-import-method=copy`。
- **上传大小约 4.4 MB 上限。** 经 Lambda 与 AgentCore 的请求体有大小限制，大附件会上传失败。
- **访问令牌无法吊销。** 登出会调用 `GlobalSignOut`，刷新令牌随之失效；但已签发的访问令牌在过期前（默认 12 小时）仍可使用。cookie 为 `HttpOnly; Secure`。
- **设置面板：没有模型页，插件页可用。** 插件页有终端、Agent 循环、Subagent、网页搜索四张卡片和已加载插件列表，保存的配置按用户生效。网页搜索的 API key 与接口地址由部署管理，改动会被拒绝，页面提示「本部署没有接受这些值」。DSH 0.1.5-rc.3 的插件页不能安装新插件。
- **「通用设置」里的「打开配置文件」按钮不可用。** 它会在 microVM 里打开本机编辑器，点击后被部署拒绝。
- **设置过滤不是安全边界。** 适配器只过滤浏览器发来的设置与凭证 RPC；用户在 bash 里直接改 `$DSH_HOME/settings.yaml` 仍能改模型路由等设置（只影响自己）。
- **DeepSeek key 是整个部署共享的，用户可以取得和消耗。** key 不在 DSH 进程里，但用户可以在 bash 中直接调用本地代理，或用执行角色读取 secret。只适合 PoC。
- **建议在新会话中切换模型来源。** 同一会话中途从 DeepSeek 官方切到 Bedrock `deepseek.v3.2`，实测出现过一次乱码回复。
- **IAM 拒绝被显示为「API 密钥无效」。** 执行角色没有模型权限时，DSH 把 Bedrock 的 403 显示成 API 密钥错误。排障以适配器日志 `model call` 中的 `errorBody` 为准。
- **WebSocket 每小时断开一次。** AgentCore 在 1 小时后以 1008 关闭连接，页面会显示「自动重连中…」，约 1 秒内恢复。
- **执行角色凭证在 microVM 内可见。** 用户可以通过工具用执行角色调用模型，但权限只限所选模型，只影响本会话的用量。
- **DSH 是 developer preview。** 版本已锁定（`services/adapter/runtime/package-lock.json`），升级前要重跑本机集成测试与端到端测试。

更完整的限制与风险表见 `.kiro/specs/poc/design.md`「已知限制与风险」。

## 开发与测试

```bash
npm run build && npm run lint
npm test                      # 单元 + 属性测试（Property 1–11）+ CDK 合成不变量
npm run test:integration      # 本机：适配器 + dsh web + 模拟模型（含模拟 DeepSeek 搜索）+ 浏览器（约 5 分钟）
npx tsx test/e2e/cloud.ts [E U G P S K C L M]  # 真实部署上的端到端用例
```

浏览器用例在 Windows 侧的 Edge 上运行（WSL 中没有浏览器依赖库）：`WIN_UI_DIR`（默认 `/mnt/c/Users/zhang/dsh-poc-ui`）下需要用 Windows 侧 npm 安装 `playwright-core@1.63.0`。

端到端用例使用用户 `alice`、`bob`、`carol`、`dave`、`erin`，需要以 `-c demoUsers=demo,alice,bob,carol,dave,erin` 部署。各阶段如下：

| 阶段 | 覆盖 |
|---|---|
| E | 入口与鉴权（C01–C06）、跨用户隔离与 JWT 授权器（C07–C15）、令牌过期续期（C16–C17）、`/plugins/*` 共享缓存（C18）、登出（C19） |
| G | 插件设置页（G01–G06：有插件页、无模型页、保存与持久化、网页搜索 key/地址被锁定、插件列表）；配置了 DeepSeek key 时真实模型调用 `web_search`（G07） |
| U | 浏览器 + 真实模型：加载、工作区、对话、工具调用、多轮、文件预览、停止生成、过期令牌续期、超过 64 KB 的历史刷新；另一用户隔离；两名用户并发对话 |
| P | 写入 → `StopRuntimeSession` → 重新打开：历史与文件仍在，冷启动 ≤ 60 s |
| S | 页面打开时 `StopRuntimeSession`：自动重连、不刷新继续对话、刷新后历史可见 |
| K | 同一会话 30 个并发请求 |
| C | 清除 `/plugins/*` 缓存前后的首页加载耗时 |
| L | 页面保持 70 分钟（`HOLD_MIN`）：1 小时 1008 断开后自动重连并继续对话 |
| M | `maxLifetime` 到期回收（需以 `-c maxLifetimeSeconds=300 -c idleRuntimeSessionTimeoutSeconds=240` 部署） |

用例可以在已有数据的会话上重复运行（每次运行生成新的 runId）。结果写到 `test/e2e/results/`（`summary-<阶段>.md`、`history.log`），截图与原始记录写到 `test/results/e2e/`。

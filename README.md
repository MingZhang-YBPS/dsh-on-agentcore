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

长期试用前需要改为「每用户一个 Runtime + EFS」（设计决策点 D4），PoC 阶段接受上述行为。

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

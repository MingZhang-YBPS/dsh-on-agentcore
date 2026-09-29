# Implementation Plan: DSH on AgentCore PoC

## Overview

架构已调整为「官方 DSH Web UI + 每名用户一个 AgentCore 运行时会话 + 托管 session storage」，详见 design.md。

实现语言：TypeScript（Node.js 22）+ AWS CDK v2；测试使用 Vitest + fast-check；浏览器用例使用 playwright-core（在 Windows 侧的 Edge 上运行）。适配器、隧道 Lambda 与 CloudFront Function 的首版代码都从 `spikes/06-webui-tunnel/` 移植而来。

计划分两段：
1. 第 1 组是技术验证，1.1–1.9 已全部完成。其中 1.1–1.5 属于旧架构，结论中仍然有效的部分已并入新 design.md。
2. 第 3 组起是增量实现，顺序为：纯函数与属性测试 → 适配器 → 隧道与 CloudFront → CDK → 可观测性 → 端到端。

## Tasks

- [x] 1. 技术验证
  - [x] 1.1 选定 Cognito 认证失败计数方案并回修认证设计
    - `spikes/01-cognito-throttle/`：PostAuthentication 在口令错误时不触发；Cognito 内建锁定不可配置，且返回的消息与普通失败不同
    - 结论：由自有代码代理登录（`AdminInitiateAuth`），失败计数存放在 DynamoDB。新架构中这部分由隧道 Lambda 承担
    - _Requirements: 2.3, 2.4, 2.5_

  - [x] 1.2 验证停止生成链路并删除"兜底路径"
    - `spikes/02-stop-generation/`：进程组 SIGTERM→SIGKILL、需要 init 进程作为 PID 1 等结论仍然有效
    - 新架构中停止生成由 DSH 自己完成（Spike 06 实测 0.5–0.7 s），RUNCTL 轮询方案作废
    - _Requirements: 3.6_

  - [x] 1.3 验证会话级工作空间隔离的凭证机制
    - `spikes/03-session-isolation/`：AgentCore 不会把会话标签传给执行角色凭证，microVM 内所有进程都能拿到执行角色凭证
    - 结论沿用为「执行角色最小权限」。STS 会话标签方案随 S3 工作空间存储一起作废
    - _Requirements: 4.3, 6.3_

  - [x] 1.4 验证 CloudFront + Lambda Function URL 的 SSE 链路并修正超时设计
    - `spikes/04-cloudfront-sse/`：CloudFront 对流式响应不做缓冲；`HttpResponseStream` 必须先 write 再 end；OAC 要求请求带 `x-amz-content-sha256`
    - 新架构因此不用 OAC，改用源站密钥头
    - _Requirements: 3.3_

  - [x] 1.5 锁定 DSH 版本并验证集成接口
    - `spikes/05-dsh-pin/`：锁定 `@deepseek-ai/dsh@0.1.5-rc.3`；模型调用经签名代理；外联记录代理实测 0 次非回环外联
    - _Requirements: 3.1, 3.10, 6.1, 6.2_

  - [x] 1.6 验证官方 Web UI 经隧道运行在 AgentCore 上
    - `spikes/06-webui-tunnel/`：本机 23/23、AgentCore 18/18、CloudFront + Cognito 22/22；已清理全部 AWS 资源
    - 结论已写入新的 requirements.md 与 design.md（会话 ID 派生、归属校验、DSH_HOME 镜像、WebSocket 保活、`?` 查询串、`/ws` 上 `Authorization` 头大小写、Lambda 空响应体写法）
    - _Requirements: 2.8, 2.10, 2.11, 3.2, 3.3, 3.8, 3.9, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4_

  - [x] 1.7 在 AgentCore 上验证真实 Bedrock 模型
    - `spikes/07-bedrock-model/`：本机 27/27、AgentCore 20/20；AWS 资源已全部清理
    - 可用模型：`deepseek.v3.2` 在 `bedrock-runtime` 与 `bedrock-mantle` 两个端点面上都能调用；`deepseek.v3.1` 只在 mantle 上；R1 在 OpenAI 兼容端点上返回 404
    - 权限与签名：
      - SigV4 服务名：runtime 端点面为 `bedrock`，mantle 端点面为 `bedrock-mantle`
      - 执行角色最小权限：runtime 端点面只要 `bedrock:InvokeModel`，资源为基础模型 ARN；mantle 端点面要 `bedrock-mantle:CreateInference`，资源为 `project/default`。无权调用其他模型已实测
    - 请求与响应：DSH 请求体原样可用；V3.2 会把 `<｜DSML｜function_calls` 漏进正文，签名代理必须过滤（已实现并验证）
    - 已回修 design.md：关键决策表模型行、「1. 适配器」签名代理、「5. 模型接入」、Property 10、Error Handling、CDK 执行角色、配置参数 `modelId`、preflight、风险表
    - _Requirements: 1.5, 1.7, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 1.8 验证 IaC 下的 Runtime 版本语义与部署失败语义
    - `spikes/08-deploy-semantics/`：用 CDK L1 `CfnRuntime` 创建与更新 session storage、请求头白名单、JWT 授权器，都能成功
    - Runtime 的**任何**属性变更（标签、描述、环境变量、生命周期、代码）都会产生新版本并清空 session storage；清空是惰性的，发生在 microVM 回收之后；无变更的重复部署不产生版本
    - 失败语义：默认回滚能恢复原配置，但会产生两个版本；`--no-rollback` 会停在 `UPDATE_FAILED`，修复后再部署被判定为「无变更」，必须先 `cdk rollback`。选定默认回滚，另外轮询栈状态，不依赖 cdk 进程返回
    - 另外两项发现：JWT 授权的 Runtime 上 `StopRuntimeSession` 必须用 Bearer 令牌；Runtime 日志组不随栈删除
    - 已回修 design.md「部署与卸载流程」、风险表，并新增决策点 D4（用户数据如何跨 Runtime 版本保留）
    - _Requirements: 1.3, 1.4, 1.8_

  - [x] 1.9 验证长连接与令牌过期下官方 UI 的行为
    - `spikes/09-longlived/`，结论见其 README
    - **发现 AgentCore `/ws` 单帧 64 KB 上限**：会话历史较长时刷新页面会反复断线。适配器改为分片发送后问题消失（Property 11）
    - microVM 回收（`StopRuntimeSession`、`maxLifetime` 到期）：页面约 1 s 内自动重连，不刷新可以继续对话，刷新后历史仍在
    - 令牌过期：已建立的 WebSocket 继续可用，但发消息的 HTTP 请求返回 401，界面没有提示。因此在隧道 Lambda 中加入滑动续期（任务 5.1）
    - 长连接（同区域 EC2 实测）：AgentCore 对每条 WebSocket 有 1 小时连接时长上限，到时以 1008 关闭；只有 WebSocket、没有 HTTP 的会话不会被空闲回收。本机测试中 11 分钟、17 分钟处的断线是本机网络抖动造成的（所有路径同时断开，EC2 上没有复现）
    - 已回修 design.md：适配器 `/ws`、「64 KB 帧上限与分片」「会话回收与重连」、隧道 Lambda 续期、Error Handling、风险表、配置参数
    - _Requirements: 2.9, 3.8, 5.3_

- [x] 2. 检查点：验证结论已回修
  - 1.8–1.9 的结论已写入 design.md；用户已确认决策点 D4（PoC 阶段接受「部署即清空」，长期试用前改为每用户 Runtime + EFS）。

- [x] 3. 仓库骨架与纯函数包
  - [x] 3.1 搭建 monorepo 骨架
    - npm workspaces：`packages/{envelope,session-identity,auth-throttle,model-stream}`、`services/{adapter,tunnel,edge}`、`infra`、`test`
    - `tsconfig.base.json` 开启 strict；Vitest 分为 `unit`、`property`、`integration` 三个项目；ESLint flat config 与 Prettier；依赖一律使用精确版本
    - _Requirements: 1.1_

  - [x] 3.2 实现 `packages/envelope`
    - 从 `spikes/06-webui-tunnel/src/lib/envelope.mjs` 移植：`encodeRequest` / `decodeRequest` / `encodeResponseHead`，以及流式的响应头解析器（支持任意切块）
    - _Requirements: 3.3_

  - [x] 3.3 编写 Property 1 属性测试：封包往返一致性
    - **Property 1: 封包往返一致性**
    - **Validates: Requirements 3.3**

  - [x] 3.13 在 `packages/envelope` 中实现 WebSocket 消息分片 `fragment(buf, max)`
    - 从 Spike 06 适配器的 `sendFragmented` 移植为纯函数：返回 `[{data, fin}]`，由适配器按顺序发送
    - _Requirements: 3.3, 3.8_

  - [x] 3.14 编写 Property 11 属性测试：WebSocket 消息分片
    - 另写一个集成用例：用 `ws` 库发送分片后的消息，确认接收端收到完整消息（含切开多字节 UTF-8 字符的文本消息）
    - **Property 11: WebSocket 消息分片**
    - **Validates: Requirements 3.3, 3.8**

  - [x] 3.4 实现 `packages/session-identity`
    - `sessionIdOf(sub)`、`sessionOwnerRejection(headers)`、`toDshHeaders` / `fromDshHeaders`
    - _Requirements: 2.10, 2.11, 3.11, 4.1_

  - [x] 3.5 编写 Property 3 属性测试：会话归属判定
    - **Property 3: 会话归属判定**
    - **Validates: Requirements 2.10, 2.11, 4.1, 4.3**

  - [x] 3.6 编写 Property 4 属性测试：会话 ID 派生
    - **Property 4: 会话 ID 派生**
    - **Validates: Requirements 4.1**

  - [x] 3.7 编写 Property 5 属性测试：转发请求头过滤
    - **Property 5: 转发请求头过滤**
    - **Validates: Requirements 2.8, 3.3, 3.11**

  - [x] 3.8 实现 `packages/auth-throttle`
    - `validateLoginInput`（按码位计数）、`evaluateThrottle`（默认 5 次 / 5 分钟 / 15 分钟，参数可调）、统一失败响应常量
    - _Requirements: 2.3, 2.4, 2.5_

  - [x] 3.9 编写 Property 6 属性测试：登录输入校验与统一失败
    - **Property 6: 登录输入校验与统一失败**
    - **Validates: Requirements 2.3, 2.4, 2.5**

  - [x] 3.10 编写 Property 7 属性测试：登录节流滑动窗口
    - **Property 7: 登录节流滑动窗口**
    - **Validates: Requirements 2.5**

  - [x] 3.11 实现 `packages/model-stream`
    - 从 `spikes/06-webui-tunnel/src/lib/proxies.mjs` 的 `createRawToolMarkupFilter` 移植：按帧改写 SSE；标记列表可配置；片段末尾可能是标记前缀时先扣住
    - _Requirements: 3.4, 3.5, 6.4_

  - [x] 3.12 编写 Property 10 属性测试：原始工具调用标记过滤
    - 以 `spikes/07-bedrock-model/results/probe-events/` 中的真实流作为种子，再用生成器构造多 choice、标记位置随机、随机切块的流
    - **Property 10: 原始工具调用标记过滤**
    - **Validates: Requirements 3.4, 3.5, 6.4**

- [x] 4. 适配器（`services/adapter`）
  - [x] 4.1 移植适配器主体
    - 基于 `spikes/06-webui-tunnel/src/adapter/index.mjs`，改为 TypeScript，并使用 3.2、3.4 的包
    - 包括：`/ping`、`/invocations`（挂起直到 DSH 就绪）、`/ws` 桥接与保活、发往 AgentCore 一侧的消息按 3.13 分片、`ws closed` 日志（哪一侧先关闭、关闭码、原因）、SIGTERM 处理、DSH 进程退出时适配器随之非零退出
    - _Requirements: 1.11, 2.11, 3.3, 3.8, 3.11, 5.4, 7.5_

  - [x] 4.2 移植 DSH_HOME 镜像
    - 基于 `home-mirror.mjs`：启动时恢复、按固定间隔增量同步、排除 `profiles/`，并记录用量与同步耗时
    - _Requirements: 5.1, 5.3, 5.4, 7.6_

  - [x] 4.3 编写 Property 9 属性测试：DSH_HOME 镜像保真
    - 源目录与镜像目录都放在本地临时目录中；另写一个用例，把镜像目标换成禁止硬链接的包装文件系统（通过 `link` 桩函数实现）
    - **Property 9: DSH_HOME 镜像保真**
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [x] 4.4 SigV4 签名代理与模型配置
    - 移植 `proxies.mjs` 中的签名代理，包括以下几项（配置按 design.md「5. 模型接入」，即 Spike 07 结论）：
      - 用 `MODEL_SIGNING_SERVICE` 选择签名服务名
      - 把 `/openai/v1` 前缀映射到 `MODEL_BASE_URL` 的路径
      - 接入 3.11 的标记过滤
      - 非 200 响应记录 `errorBody`
      - 每次调用输出 `model call` 日志
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 7.2_

  - [x] 4.5 DSH 补丁与加固
    - 移植 `dsh/web.cordis.yml` 与 `dsh/web-hardening.cordis.yml`；构建时用 `--dump-config` 校验补丁组合
    - _Requirements: 3.9, 3.10_

  - [x] 4.6 适配器结构化日志
    - 实现 design.md「结构化日志字段」中列出的字段与事件，并做敏感字段过滤
    - _Requirements: 7.2, 7.3, 7.4, 7.6_

  - [x] 4.7 arm64 代码包构建脚本
    - 移植 `aws/build.sh`，生成 `infra/scripts/build-adapter.sh`：
      - 执行 `npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc --ignore-scripts`
      - 删除非 arm64 的 prebuild 与 `.bin`
      - 校验包内全部 ELF 文件均为 aarch64，且 zip 小于 250 MB
    - _Requirements: 1.1_

  - [x] 4.8 本机集成测试
    - 移植 `run_local.mjs`：适配器 + dsh web + 本机网关 + 模拟模型上游 + 外联记录代理，覆盖浏览器用例 U01–U09 与 L01–L11
    - 另设一组真实模型用例（移植 `spikes/07-bedrock-model/ui/real-suite.mjs` 的 R01–R05、E01，需要 AWS 凭证），用于升级 DSH 或切换模型前的回归
    - _Requirements: 3.2, 3.4, 3.5, 3.6, 3.7, 3.9, 3.10, 5.2_

- [x] 5. 隧道 Lambda 与 CloudFront Function
  - [x] 5.1 实现隧道 Lambda
    - 基于 `spikes/06-webui-tunnel/cloud/lambda/index.mjs`，包括：
      - 源站密钥校验、登录页（满足可访问性要求）、登录与节流（DynamoDB，乐观并发）
      - 登出（`AdminUserGlobalSignOut`，同时清除两个 cookie）
      - 滑动续期：登录时下发 `dsh_refresh`；访问令牌剩余有效期低于 `tokenRefreshSkewSeconds` 时，先用 `REFRESH_TOKEN_AUTH` 续期再转发；刷新失败按令牌无效处理（Spike 09 T 阶段）
      - 封包转发，含 409 退避重试
      - 空响应体也写一次、还原 `x-dsh-raw-query`、结构化日志
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.9, 2.10, 2.12, 2.13, 3.3, 4.5, 7.1, 7.4_

  - [x] 5.2 实现两个 CloudFront Function
    - `default-rewrite`：先放以 `?` 开头的键；`ws-rewrite`：`Authorization` 头必须按这个大小写设置，`sub` 须符合 UUID 形态，并删除 `Cookie` 与 `Origin`
    - 用 `aws cloudfront test-function` 编写边界用例，覆盖多值查询、空值和键顺序打乱的情况
    - 实现说明：边界用例在 Node vm 中覆盖（`services/edge/test/`、Property 2）；部署后的真实行为由端到端 C05、C18 与全部浏览器用例覆盖
    - _Requirements: 2.8, 2.10, 3.3_

  - [x] 5.3 编写 Property 2 属性测试：原始查询串重写保真
    - 在 Node 中执行函数源码（模拟 `cloudfront-js-2.0` 的事件结构）
    - **Property 2: 原始查询串重写保真**
    - **Validates: Requirements 3.3**

  - [x] 5.4 编写 Property 8 属性测试：日志不含敏感值
    - 同时覆盖隧道 Lambda 与适配器的日志器
    - **Property 8: 日志不含敏感值**
    - **Validates: Requirements 7.4**

- [x] 6. CDK 基础设施（`infra/`）
  - [x] 6.1 `AuthConstruct` 与 `RuntimeConstruct`
    - 包括：User Pool、App Client、演示用户与 Secrets Manager、`DshPocAuth` 表
    - 包括：代码包资产、最小权限的执行角色，以及 `CfnRuntime`（session storage、请求头白名单、JWT 授权器、生命周期）。Runtime 属性中不放任何随部署变化的值（Spike 08：任何变更都会清空数据）
    - App Client 设置刷新令牌有效期（`refreshTokenValidityDays`）；另建一个运维用户，用于需要 Bearer 令牌的数据面运维调用（`StopRuntimeSession`）
    - _Requirements: 1.1, 2.6, 2.7, 4.1, 5.1, 6.2, 6.3_

  - [x] 6.2 `TunnelConstruct` 与 `EdgeConstruct`
    - 包括：Lambda、Function URL、源站密钥、两个函数（部署时替换 ARN）、WebSocket 缓存策略、分发
    - _Requirements: 1.1, 1.2, 2.12, 3.3, 3.8_

  - [x] 6.3 `/plugins/*` 可缓存行为
    - 缓存键包含 `x-dsh-raw-query`，并要求请求带有 cookie；测量缓存命中前后的首页加载耗时
    - 实现说明：共享缓存的响应不得带 `Set-Cookie`（隧道对 `/plugins/*` 不续期、不透传 Set-Cookie；响应头策略再删一次）
    - 测量（`cloud.ts C`，新浏览器上下文、登录提交→输入框可用）：插件包实际为 2 个请求、压缩后 4.2 MB；清除缓存后首次 9.2 s，命中后 8.4–10.0 s。缓存生效（跨用户命中），但在测试客户端上对加载耗时的改善在噪声范围内：耗时主要在客户端下载与 DSH 前端初始化后的串行 API 调用。缓存的收益主要是每次加载少一次经 Lambda → AgentCore 的 4 MB 传输
    - _Requirements: 3.2_

  - [x] 6.4 preflight / deploy / destroy 包装脚本
    - preflight：参数与模型可用性校验，30 秒硬超时
    - deploy：`cdk diff` 中只要出现 `AWS::BedrockAgentCore::Runtime` 的变更，就要求 `acceptDataWipe=true`；使用 CloudFormation 默认回滚；同时轮询 `describe-stacks`，一旦进入 `*_FAILED` / `*ROLLBACK*`，就从栈事件中输出失败资源与原因并以非零退出
    - destroy：需要显式确认，30 分钟计时，逐项输出删除结果；另外按前缀删除 Runtime 日志组 `/aws/bedrock-agentcore/runtimes/<id>-*`
    - 实现说明：preflight 已对真实账号执行（v3.2 通过；R1 按预期 404 失败）；deploy / destroy 的完整流程在任务 7 验证，数据清空保护在任务 8.2 实际触发过
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [x] 6.5 `ObservabilityConstruct`
    - 日志组保留 14 天；Dashboard 包含 Lambda 状态码分布、适配器 warn/error 计数、冷启动耗时
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 7. 检查点：可部署
  - 在干净的账号中执行 preflight → deploy → 重复 deploy（输出「无变更」）→ destroy，各一次。确保所有测试通过，有问题询问用户。
  - 结果（us-east-1，2026-09-27）：deploy 310 s（Runtime v1）；重复 deploy：代码包重新构建后字节不变，`cdk diff` 报告 There were no differences，`(no changes)`，仍为 v1；destroy 249 s，逐项输出 39 个资源的 DELETE_COMPLETE，并清理了残留的日志组，核对无 Runtime、日志组、分发残留。日志：`test/results/deploy/t7-*.log`（不入库）

- [x] 8. 真实 AWS 端到端（需用户明确授权后执行）
  - [x] 8.1 端到端用例
    - 移植 `run_cloud.mjs` 与 `ui/ui-suite.mjs`，覆盖 C01–C15、U01–U06、U10，并加上真实模型的对话与工具调用
    - 用例必须能在已有数据的会话上重复运行
    - 实现：`test/e2e/cloud.ts`（阶段 E、U、C）+ `test/e2e/ui/cloud-suite.mjs`。结果 `test/e2e/results/summary-{E,U,C}.md`：E 19/19（C01–C19，含过期令牌续期、`/plugins/*` 跨用户命中且无 Set-Cookie、登出使刷新令牌失效）；U 13/13（真实模型对话、工具调用、多轮、文件预览、停止生成、过期令牌续期不中断、89 KB 消息刷新后收到 222 KB 的单条 WebSocket 消息、隔离、两名用户并发对话）
    - 真实模型带来的不确定性：模型偶尔拼错固定回复、先长时间思考、或无视「不要调用工具」。用例改为只匹配回复中的唯一 id、在输出开始后再点停止、等待工具调用标记出现
    - _Requirements: 2.1, 2.2, 2.3, 2.8, 2.11, 2.12, 3.2, 3.4, 3.5, 3.6, 3.7, 4.2, 4.3, 6.4_

  - [x] 8.2 持久化与回收用例
    - 写入会话与文件 → `StopRuntimeSession` → 再次访问，确认历史与文件都在，冷启动 ≤ 60 s
    - 移植 `spikes/09-longlived/`：页面打开时回收（Stop 与 `maxLifetime`）→ 自动重连 → 不刷新对话 → 刷新后历史可见（覆盖历史快照超过 64 KB 的长会话）；令牌接近过期时续期生效、页面不中断；页面保持超过 1 小时，确认 1008 关闭后页面能自动重连
    - 两名用户同时对话，互不可见；同一会话 30 个并发请求全部成功
    - 结果：P 6/6（Stop 后重新打开：登录→首页可用 16.6 s，适配器启动到 DSH 就绪 4.7 s，会话历史与 hello.txt 都在）；S 3/3（关闭后 1 s 内重连）；M 3/3（`maxLifetime=300` 部署：306 s 关闭、307 s 重连）；L 3/3（页面保持 70 分钟：WebSocket 在 3647 s 被关闭，同一秒重连，之后不刷新对话成功；适配器侧记录为上游 1006）；K 1/1（30/30）；令牌续期见 8.1 的 C16、U12
    - 同时验证了数据清空保护：从 `maxLifetime=300` 改回默认值时，不带 `acceptDataWipe` 的部署以退出码 3 拒绝，带上后 Runtime v1 → v2
    - _Requirements: 1.11, 4.4, 4.5, 5.2, 5.3, 5.5_

  - [x] 8.3 README 与已知限制
    - 部署步骤；数据清空场景（Runtime 的任何变更、14 天未使用、卸载），以及清空的惰性特点；1 GB 上限；硬链接与 pnpm；上传约 4.4 MB 上限；访问令牌不可吊销；设置面板显示 404；IAM 拒绝被显示为「API 密钥无效」
    - _Requirements: 5.6_

- [x] 9. 最终检查点
  - 确保所有测试通过，AWS 资源已按需保留或清理，有问题询问用户。
  - 静态检查、单元与属性测试（53）、本机集成（4/4）、端到端各阶段均通过。按用户要求保留栈 `DshPoc`（Runtime v2，默认参数，`demoUsers=demo,alice,bob,carol,dave,erin`）供手动测试

- [x] 10. 插件设置页与 DeepSeek 网页搜索（用户在任务 9 之后提出）
  - [x] 10.1 补丁：只关闭模型设置页；开放插件设置页及 `settings-controller`；`web-search-deepseek` 指向适配器内的 DeepSeek 代理
    - _Requirements: 3.9, 3.12_
  - [x] 10.2 适配器：DeepSeek 代理（key 来自 Secrets Manager，只放行 `POST /anthropic/v1/messages`）与设置/凭证 RPC 的服务端过滤；单元测试
    - _Requirements: 3.9, 3.12, 3.13_
  - [x] 10.3 基础设施：DeepSeek key 的 secret（模板只有占位值）、执行角色读权限、`DEEPSEEK_API_KEY` 经 deploy 包装器写入、preflight 校验 key
    - _Requirements: 3.13_
  - [x] 10.4 本机集成阶段 G（`plugins-suite.mjs`，模拟 DeepSeek 搜索）：G01–G07 与 L13 通过；设置过滤（L10）通过
    - _Requirements: 3.9, 3.12, 3.13_
  - [x] 10.5 部署并在真实环境运行端到端阶段 G（用户已确认清空数据并提供 DeepSeek API key）
    - 第一次部署（Runtime v3）后阶段 G 失败：经 CloudFront 访问时页面地址不是回环地址，DSH 客户端把设置只放在浏览器内存里，插件卡片为空（本机测试用 localhost，没有暴露）。修正：适配器在首页注入官方传输钩子 `ownsHost`（design.md「4. DSH 配置与加固」）；本机集成改用非回环主机名，并确认不注入时同样失败
    - 第二次部署 Runtime v4；key 经 api.deepseek.com 校验后写入 secret（不改动 Runtime）。结果：阶段 G 8/8（真实模型调用 web_search 返回 docs.aws.amazon.com 来源）、E 19/19、U 13/13
    - _Requirements: 3.12, 3.13_

- [x] 11. 对话模型改为 DeepSeek 官方为默认、保留 Bedrock（用户选择方案 B）
  - [x] 11.1 补丁：启用 `llm-deepseek`（经 DeepSeek 代理、占位 key 引用、只列可用的两个模型；未配置 key 时整行关闭）；默认模型由适配器按 key 是否配置决定
    - _Requirements: 6.1, 6.2_
  - [x] 11.2 DeepSeek 代理放行 `POST /chat/completions` 与 Files API；单元测试
    - _Requirements: 6.2_
  - [x] 11.3 本机集成：阶段 A、G 走 DeepSeek 官方路径（L14：请求带代理注入的 key），阶段 B、F 走 Bedrock（L15：SigV4）；5/5 通过
    - _Requirements: 6.1, 6.2, 6.4_
  - [x] 11.4 部署 Runtime v5；端到端 E 19/19、U 17/17（含 U14 新会话切换模型、U16 默认 DeepSeek-V4.1-Flash、U15 记录中途切换）、G 8/8、P 6/6、S 3/3、K 1/1
    - 修正用例：模型回复里出现行内代码 `hello.txt` 时，文件预览用例误点对话正文；改为只点右半屏文件树并在预览区检查内容
    - _Requirements: 6.1, 6.4_

- [ ] 12. 每用户运行时 + 专属 EFS（D4 方案 A，用户在任务 11 之后提出；独立的栈 `DshPerUser`，不改动 `DshPoc`）
  - [x] 12.1 在不改变 `DshPoc` 合成结果的前提下重构构件
    - `RuntimeConstruct` 拆出执行角色、适配器环境变量、JWT 授权器等构造函数；`TunnelConstruct`、`EdgeConstruct`、`ObservabilityConstruct` 参数化；`AuthConstruct` 增加 `addUser`
    - 隧道 Lambda 的每用户逻辑放进新入口 `per-user.ts`，`index.ts`、`handler.ts`、`ports.ts` 不变
    - 每用户 Runtime 使用新代码包 `adapter-per-user.zip`，`adapter.zip` 不变
    - 验证：以线上用户列表重新合成 `DshPoc`，模板与全部资产哈希逐字节相同；线上 `cdk diff DshPoc` 为 no differences（每轮改动后都复核）
    - _Requirements: 8.1_
  - [x] 12.2 网络与每用户资源
    - L1 VPC：按可用区 ID 建子网；默认单可用区、单 NAT；两个可用区时各有自己的 NAT；私有子网带 S3 网关端点
    - 每名用户一个嵌套栈：EFS（文件系统策略限定执行角色与 TLS）、挂载目标、访问点 991:991、执行角色、Runtime（VPC 模式，`customClaims` 要求 `username`，`DSH_HOME_MIRROR=0`）、Cognito 用户与口令 secret（主栈的 provisioner 按标签读取）
    - _Requirements: 8.2, 8.3, 8.4, 8.10_
  - [x] 12.3 路由
    - DynamoDB 路由表，由嵌套栈里的 `Custom::DshPerUserRoute` 写入，同一个自定义资源也负责日志组保留期
    - 隧道 Lambda 查表（缓存 60 s），并下发 `dsh_rt`
    - `ws-rewrite-per-user.js` 按 `dsh_rt` 拼 ARN，并核对其名称部分与令牌 `username` 一致
    - _Requirements: 8.7, 8.8_
  - [x] 12.4 部署脚本
    - `-c stack=DshPerUser` 与 `deploy:per-user` 等别名
    - 数据保护：EFS 文件系统删除或替换、嵌套栈删除时要求 `acceptDataWipe`；Runtime 变更只提示
    - 部署结束时汇总嵌套栈输出，失败时输出嵌套栈里失败资源的原因
    - 卸载时按前缀清理日志组，并对网卡延迟释放给出提示
    - _Requirements: 8.6, 8.12_
  - [x] 12.5 首次部署与修正（alice、bob，us-east-1）
    - 弹性 IP 配额已满，提额到 25
    - 执行角色补 `elasticfilesystem:DescribeAccessPoints` / `DescribeMountTargets`
    - AgentCore 先启动进程、后挂载 EFS：新增入口 `per-user-entry.js` 等待挂载
    - 结果：
      - 协议级 12/12：授权器按 `username` 拒绝他人令牌（HTTP 401，`/ws` 403），CloudFront Function 拒绝他人或缺失的 `dsh_rt`，登出清除 `dsh_rt`；
      - 浏览器 W/P 6/6：写文件、回收后历史与文件仍在，冷启动约 14 s
    - _Requirements: 8.2, 8.3, 8.8, 8.9_
  - [x] 12.6 跨 Runtime 版本保留数据：v2 写入 alice、bob 的数据，经 v3、v4 两次只改 Runtime 的部署，每次回收后数据都在；包装器没有拦截
    - _Requirements: 8.5, 8.6_
  - [x] 12.7 DeepSeek key 可按用户独立
    - 参数 `deepseekSecretPerUser`，环境变量 `DEEPSEEK_API_KEY_<用户>`，preflight 逐个校验
    - 演示部署先用共享 key；回收后模型列表出现 DeepSeek 官方模型
    - Bedrock 仍按执行角色 IAM/SigV4 调用
    - _Requirements: 8.11_
  - [ ] 12.8 为每用户形态补充自动化测试
    - `ws-rewrite-per-user.js` 与 `per-user.ts` 的单元测试，`DshPerUser` 合成不变量测试，`deploy-guard` 的 EFS 与嵌套栈用例
    - 让 `test/e2e/cloud.ts` 支持 `DshPerUser`：从嵌套栈读输出，用用户自己的令牌调用 `StopRuntimeSession`
    - 本轮只用一次性脚本验证过，脚本已删除
    - _Requirements: 8.3, 8.5, 8.6, 8.8_
  - [x] 12.9 为单个用户安装记忆插件（bob）
    - `dsh-memory-eternal` 0.7.0 在 rc.3 上不能自动记忆：它读 `agent.session.events`，DSH 0.1.2 起已移除，已卸载
    - 改装 `@alanzhao/dsh-memory-lite` 0.3.0，并把 profile 里的 `@deepseek-ai/schemastery` 固定为宿主的 3.18.2（否则 DSH 启动失败）
    - 实测：自动提取、新会话召回、回收后召回均通过
    - 步骤见 `docs/memory-plugin-dsh-memory-lite.md`；按用户要求不纳入部署流程
    - _Requirements: 8.2_

## Notes

- 每条设计属性对应一个属性测试，紧跟被测实现。测试文件为 `test/properties/pNN-*.test.ts`，头部标注 `// Feature: poc, Property N: ...`。
- 7、8.x 会调用真实 AWS，执行前需要用户授权。
- 12.x 的每用户形态部署在独立的栈 `DshPerUser` 中；每轮改动都复核 `DshPoc` 的合成结果与线上 `cdk diff` 不变。
- 新增依赖一律使用精确版本。
- 已作废的旧任务（自建 SPA、DynamoDB 历史、S3 工作空间快照、RUNCTL 停止链路、消息序号、工作空间 GC）不再列出，原因见 design.md Overview。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["3.1"] },
    { "id": 1, "tasks": ["3.2", "3.4", "3.8", "3.11", "3.13"] },
    { "id": 2, "tasks": ["3.3", "3.5", "3.6", "3.7", "3.9", "3.10", "3.12", "3.14"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.4", "4.5", "5.1", "5.2"] },
    { "id": 4, "tasks": ["4.3", "4.6", "4.7", "5.3", "5.4"] },
    { "id": 5, "tasks": ["4.8", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.5"] },
    { "id": 7, "tasks": ["6.3", "6.4"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3"] }
  ]
}
```

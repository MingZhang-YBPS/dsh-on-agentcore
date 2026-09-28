# Spike 07：在 AgentCore 上验证真实 Bedrock 模型

对应 tasks.md 任务 1.7（Requirements 1.5、1.7、6.1–6.5）。结论已写回 `.kiro/specs/poc/design.md`（关键决策表「模型接入」行、「5. 模型接入」、配置参数、CDK 执行角色、风险表）。

结论：可行。默认使用 `deepseek.v3.2` + `bedrock-runtime` 端点面。有一个必须处理的问题：DeepSeek V3.2 会把原始工具调用标记漏进正文，因此签名代理必须过滤。本机 27/27、AgentCore 20/20 通过。

## 关键发现（us-east-1，2026-09-27）

| 项 | 结果 |
|---|---|
| 可用的 DeepSeek 模型 | `deepseek.v3.2`：按需调用，本区域直接可用。`deepseek.r1-v1:0`：只能经 `us.` 推理配置调用。`deepseek.v3-v1:0`：us-east-1 没有，us-west-2、us-east-2、ap-northeast-1 有。账号对以上模型均已授权（`get-foundation-model-availability`） |
| OpenAI 兼容端点能调用哪些模型 | `bedrock-runtime …/openai/v1`：只能调用 `deepseek.v3.2`；R1 的两种 ID 都返回 404 `model_not_found`；`GET /models` 返回 404 `UnknownOperation`。`bedrock-mantle …api.aws/v1`：`/models` 列出 `deepseek.v3.1` 与 `deepseek.v3.2` |
| SigV4 服务名 | `bedrock-runtime` 端点面用 `bedrock`；`bedrock-mantle` 端点面用 `bedrock-mantle`（用 `bedrock` 签名也能通过） |
| 最小 IAM 权限（受限角色逐项实测） | `bedrock-runtime`：只需要 `bedrock:InvokeModel`，资源为 `arn:aws:bedrock:<region>::foundation-model/deepseek.v3.2`。流式调用同样要这个动作，只给 `InvokeModelWithResponseStream` 会被拒绝。`bedrock-mantle`：需要 `bedrock-mantle:CreateInference`，资源为 `arn:aws:bedrock-mantle:<region>:<account>:project/default`，按项目授权，不能限定到具体模型 |
| DSH 请求字段 | DSH 的完整请求体（23 个工具、`store:false`、`max_completion_tokens`、`stream_options.include_usage`）在两个端点面上都被接受，不需要改字段 |
| SSE 格式 | 标准 `data: {…}\n\n` + `data: [DONE]`。每个 choice 多一个 `obfuscation` 字段，DSH 会忽略它。末尾有 usage 片段。V3.2 默认不输出 `reasoning_content` |
| 工具调用格式 | `tool_calls` 在**一个**片段里整体到达（`id`、`type`、`function.name` 和完整的 `arguments`），前面有若干空 delta；`finish_reason=tool_calls`。回填 `role:"tool"` 结果后能正常续答，多轮上下文正确 |
| **原始标记泄漏** | `deepseek.v3.2` 在返回结构化 `tool_calls` 的同时，会把 `<｜DSML｜function_calls` 漏进 `delta.content`，两个端点面都有，12 次调用每次都出现（`probe-tools.jsonl`）。DSH 把它当正文，显示在「N 次工具调用」折叠区里，并写入会话历史。`deepseek.v3.1`（只有 mantle 端点面提供）6 次都没有出现 |
| 错误形态 | 模型 ID 不存在：400 `validation_error`。IAM 拒绝：`bedrock-runtime` 返回 401 `permission_denied_error`，`bedrock-mantle` 返回 403 `access_denied`。DSH 把 401 显示为「本轮运行失败 API 密钥无效 AUTH」，真实原因只能从适配器日志的 `model call.errorBody` 中看到 |

## 修复：签名代理过滤原始工具调用标记

`spikes/06-webui-tunnel/src/lib/proxies.mjs` 中的 `createRawToolMarkupFilter()` 逐帧改写 SSE 流：
- 某个 choice 的正文里一旦出现 `<｜DSML｜`、`<｜tool▁calls▁begin｜>` 或 `<｜tool▁call▁begin｜>`，就丢弃这个标记以及它后面的全部正文。
- 如果某个片段的末尾可能是标记的前缀，先扣住这一段，等下一个片段或 `finish_reason` 到达后，再决定放行还是丢弃。
- `tool_calls`、`finish_reason`、`usage` 与帧数都保持不变。
- 默认开启，设置 `MODEL_STRIP_RAW_TOOL_MARKUP=0` 可以关闭。

离线检查 `src/test-filter.mjs`：把录下的 5 条真实流各按随机字节切块 500 次，断言正文、工具调用与帧数都正确，且不含标记的流过滤前后逐字节相同。结果全部通过。

加上过滤后，界面展开折叠区、以及 DSH 会话日志中都不再出现标记（R03、L04）。AgentCore 日志显示每轮工具调用剥离 1 次（A01）。

另外两处对 Spike 06 代码的改动：
- 签名代理把 DSH 请求路径中的 `/openai/v1` 前缀映射到 `MODEL_BASE_URL` 的路径上，所以 `MODEL_BASE_URL` 直接填端点面的完整 base URL。适配器新增 `MODEL_SIGNING_SERVICE` 环境变量。
- 每次模型调用输出一条 `model call` 结构化日志，字段为：状态码、耗时、是否被取消、剥离次数、错误摘要。

## 实测结果

**本机**（适配器 + 加固补丁 + 真实 Bedrock，Windows 侧 Edge）27/27，见 `results/local-summary.md`。

| 组合 | 文本回复 | 工具调用回合 | 停止生成（点击 → 控件消失） |
|---|---|---|---|
| bedrock-runtime / v3.2 | 1.6 s | 3.0 s | 87 ms |
| bedrock-mantle / v3.2 | 1.5 s | 3.2 s | 73 ms |
| bedrock-mantle / v3.1 | 1.6 s | 1.8 s | 71 ms |
| 模型 ID 无效 | 界面显示 `validation_error`，页面仍然可用 | | |

全程 DSH 进程的非回环外联为 0 次。

**AgentCore**（本机网关用 SigV4 调用 → Runtime → microVM 内签名代理用执行角色凭证 → Bedrock）20/20，见 `results/agentcore-summary.md`。

| 轮次 | 结果 |
|---|---|
| A：bedrock-runtime / v3.2 | 文本 2.1 s，工具 3.8 s，停止 531 ms；4 次模型调用全部 200，剥离标记 1 次；冷启动 10.6 s，热请求 P50 444 ms |
| B：bedrock-mantle / v3.2 | 文本 1.2 s，工具 2.5 s，停止 504 ms；5 次模型调用全部 200，其中 1 次因停止生成被 DSH 取消 |
| E：bedrock-runtime / `openai.gpt-oss-20b-1:0`（执行角色无权调用） | 401 `not authorized to perform: bedrock:InvokeModel`，界面显示「本轮运行失败」，页面仍然可用。说明执行角色的最小权限生效 |
| 切换模型配置 | 每次 `update-agent-runtime` 到 READY 用时 28–35 s，每次都产生新的 Runtime 版本（2→3→4） |

## 运行

```bash
# 在仓库根目录执行
S=spikes/07-bedrock-model
$S/run.sh node $S/src/probe.mjs                 # 端点探针 → results/probe-cases.jsonl、probe-events/
$S/run.sh node $S/src/probe-tools.mjs us-east-1 6
$S/run.sh bash $S/iam-probe.sh us-east-1         # 临时创建受限角色，结束时删除
$S/run.sh node $S/src/test-filter.mjs            # 需要先有 results/probe-events
$S/run.sh node $S/src/run-local.mjs              # 需要 Windows 侧 C:\Users\zhang\spike07-ui 已 npm i playwright-core@1.63.0
bash $S/aws/setup.sh bedrock-runtime deepseek.v3.2   # 构建代码包 + 桶 + 执行角色 + Runtime
$S/run.sh node $S/src/run-agentcore.mjs
bash $S/aws/cleanup.sh
```

`run.sh` 会把 Spike 06 与 Spike 07 同步到 `~/spike07-run/spikes/` 再运行，因为 Spike 07 直接复用 Spike 06 的适配器、网关和构建脚本。

## AWS 资源

以下资源都以 `dsh-poc-spike-07` / `dsh_poc_spike_07` 为前缀：Runtime、日志组、代码桶、执行角色、IAM 探针角色。2026-09-27 已用 `aws/cleanup.sh` 删除，并逐类核对无残留。

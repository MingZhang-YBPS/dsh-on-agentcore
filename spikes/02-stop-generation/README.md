# Spike 02：停止生成链路验证

对应 tasks.md 任务 1.2（Requirements 3.6、3.7、3.8）。结论已回写 `.kiro/specs/poc/design.md`「4. DSH 适配层 → 停止生成」及相关章节。本 spike 完全在本地运行，不访问 AWS。

## 验证内容

模拟两个独立的接入服务 Lambda 调用（两个进程，不共享内存，只经 DynamoDB 通信）和一个适配层：

1. `/stop` 调用（`gateway.mjs`，`ROLE=stop`）：条件更新 `SESSION#{id} / RUNCTL`，`runId` 匹配且 `state=running` 时置为 `stopping` + `stopRequested=true`，立即返回 202。
2. 适配层（`adapter.mjs`）每 N ms 强一致 `GetItem` RUNCTL，命中后调用 `AbortController.abort()`：
   - 取消模型 HTTP 流（`fetch` + `signal`，上游模型服务记录连接断开时刻）；
   - 工具子进程以 `detached: true` 启动（独立进程组），停止时 `kill(-pgid, SIGTERM)`，500 ms 内进程组未消失则 `SIGKILL`，再最多等 300 ms，之后不再等待；
   - 不响应取消的进程内工具：与 abort 竞速，放弃等待其结果；
   - 结束 agent loop，发 `message_completed{interrupted:true, deltaCount}` 后结束响应，工作空间提交转入后台（`/ping` 返回 `HealthyBusy`）。
3. 原流式调用（`gateway.mjs`，`ROLE=chat`）收到 `message_completed{interrupted:true}` 后：已转发过内容则把已转发的 delta 拼接写成「已中断」助手消息，否则不写（3.8）；RUNCTL 置 `idle`；向浏览器发 `message_completed` 并关闭。
4. 交接前停止：适配层「冷启动」3 秒内尚未返回首字节时，由原流式调用自己以同一周期轮询 RUNCTL，命中后取消对适配层的调用、不写助手消息；适配层随后不得调用模型。
5. `runId` 匹配：同一会话的下一轮生成中，用上一轮的 `runId` 发停止，必须不影响本轮。

`runner.mjs` 扮演浏览器并逐次校验：助手消息是否标记已中断、文本是否等于已转发 delta 的拼接、`seqCounter` 与既有消息是否不变、RUNCTL 是否回到 `idle`、工具进程（含孙进程）是否全部退出、上游模型连接是否被断开。

| 文件 | 作用 |
|---|---|
| `src/upstream.mjs` | 慢速 OpenAI 兼容 SSE 服务（每 50 ms 一个片段；推理阶段只发 `reasoning_content`；工具场景发 `tool_calls`） |
| `src/adapter.mjs` | 适配层：RUNCTL 轮询、AbortController、进程组终止、中断后后台提交 |
| `src/gateway.mjs` | 接入服务的两个执行环境：`ROLE=chat` / `ROLE=stop` |
| `src/store.mjs` | DynamoDB 访问：消息追加（条件事务分配序号）、RUNCTL 状态流转 |
| `src/runner.mjs` | 场景矩阵、校验、统计，写 `results/` |
| `tools/bash_ignore_term.sh` | 忽略 SIGTERM 的工具（验证升级到 SIGKILL） |
| `tools/bash_spawn_tree.sh` | 派生子进程与孙进程的工具（验证进程组整体终止） |

## 运行

依赖：bash、docker。镜像版本固定：`node:22.23.3-bookworm-slim`、`amazon/dynamodb-local:3.3.1`；npm 依赖 `@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb` 均为 `3.1141.0`，由 `package-lock.json` 锁定。

```bash
./run.sh                                                  # 100/200/500 ms 三个间隔 × 26 次 → results/runs.jsonl、summary.md
RESULTS_TAG=ddb25ms DDB_EXTRA_LATENCY_MS=25 ./run.sh      # 每个 DynamoDB 请求额外 +25 ms（近似真实网络往返）
RESULTS_TAG=noinit NO_INIT=1 POLL_INTERVALS=200 ./run.sh  # 对照：容器不带 --init（无 PID 1 回收器）
```

单次 `run.sh` 约 30–90 秒；runner 自带 270 秒护栏，`run.sh` 外层 `timeout 290`。`EXIT` trap 删除 DynamoDB Local 容器、runner 容器与 Docker 网络；所有服务进程都是 runner 容器内的子进程，随容器退出。任一断言失败时 runner 以非零退出。

## 实测结果

运行时：Node v22.23.3（Docker），信号存储 DynamoDB Local 3.3.1（`-inMemory`）。三组共 182 次运行，**断言失败 0 次、停止耗时超过 2 秒 0 次**。完整数据见 `results/summary*.md` 与 `results/runs*.jsonl`。

停止耗时 = 停止请求到达 `/stop` 处理函数 → 原流式调用落库、RUNCTL 置 idle 并关闭响应（浏览器侧观察到流结束），单位 ms：

| 轮询间隔 | 变体 | 次数 | P50 | P95 | 最大 | 检测耗时 P50 / 最大 |
|---|---|---|---|---|---|---|
| 100 | 基线 | 24 | 117 | 638 | 673 | 79 / 124 |
| 200 | 基线 | 24 | 147 | 580 | 685 | 84 / 194 |
| 500 | 基线 | 24 | 326 | 957 | 1025 | 312 / 509 |
| 100 | DynamoDB +25 ms | 24 | 194 | 758 | 785 | 110 / 167 |
| 200 | DynamoDB +25 ms | 24 | 251 | 732 | 838 | 115 / 257 |
| 500 | DynamoDB +25 ms | 24 | 376 | 1121 | 1135 | 257 / 556 |
| 200 | 无 `--init` | 24 | 124 | 1021 | 1025 | 85 / 194 |

按场景（基线，三个间隔合并）：

| 场景 | 次数 | P50 | 最大 | 观察 |
|---|---|---|---|---|
| 模型流式输出中停止 | 24 | 131 | 400 | 上游在停止请求到达后 P50 115 ms / 最大 518 ms 观察到连接断开（含检测等待） |
| 工具忽略 SIGTERM | 12 | 638 | 1025 | 12/12 升级 SIGKILL，终止耗时 515–520 ms（= 500 ms 宽限期），记为 failure |
| 工具派生孙进程 | 12 | 96 | 506 | 12/12 SIGTERM 即终止整组（约 11 ms），收尾时全部 PID 已退出 |
| 进程内工具不响应取消 | 9 | 147 | 500 | 9/9 放弃等待，记为 failure，收尾不受该工具影响 |
| 推理阶段尚无正文时停止（3.8） | 9 | 184 | 519 | 不写助手消息；消息数与 `seqCounter` 不变；`reasoning_content` 不计为内容 |
| 冷启动期间停止（3.8） | 6 | 95 | 234 | 由流式调用在交接前命中；适配层之后未调用模型（0/6） |
| 旧 `runId` 停止下一轮 | 6 | — | — | 0/6 被误中断，停止请求返回 `accepted:false` |

其他测量：

- `/stop` 的条件 `UpdateItem`：P50 6 ms / 最大 23 ms（+25 ms 变体为 32 / 39 ms）。
- 适配层轮询 `GetItem`（强一致）P50：DynamoDB Local 4.5–5.2 ms。
- 接入服务收尾（收到 `message_completed` → 写助手消息 + RUNCTL idle + 关闭）：P50 17–25 ms；+25 ms 变体约 95–135 ms（两次顺序请求 + 事务）。
- 中断后工作空间提交（模拟 800 ms）在响应结束后于后台完成，不计入停止耗时；套件结束时 `/ping` 回到 `Healthy`。
- 无 `--init` 对照：被 SIGKILL/SIGTERM 杀死的孙进程由 PID 1（runner 自身）收养后成为僵尸，`kill(-pgid, 0)` 一直成功，派生孙进程的工具 4/4 被误判为「未退出」而升级 SIGKILL 并耗尽 300 ms 等待（终止耗时约 812 ms）。因此适配层镜像必须以 tini 等 init 进程作为 PID 1。

轮询请求量：每个活跃生成的理论 `GetItem` 频率约为 1000 /（间隔 + 读延迟），即 100 ms ≈ 9.5 次/秒、200 ms ≈ 4.9 次/秒、500 ms ≈ 2 次/秒；实测按整次运行时长折算为 6.8 / 3.6 / 1.6 次/秒（运行时长包含轮询开始前的阶段）。每次强一致读一个小于 4 KB 的项消耗 1 个读请求单位，200 ms 间隔下每小时活跃生成约 1.8 万个读请求单位；单价见 DynamoDB On-Demand 定价页。

## 结论

- 2 秒承诺在本地链路上成立：最坏的「忽略 SIGTERM 的工具 + 500 ms 间隔 + 每请求 +25 ms」组合最大 1135 ms。
- 推荐轮询间隔 200 ms：检测耗时最大约为间隔加一次读延迟；100 ms 相比 200 ms 的 P50 只少约 30–60 ms，请求量却翻倍；500 ms 的最坏值（约 1.1 s）叠加 Lambda 冷启动后余量不足。
- 停止预算（200 ms 间隔）：`/stop` 写入 ≤ 50 ms + 检测 ≤ 300 ms（+25 ms 变体实测最大 257 ms）+ 工具进程组终止 ≤ 800 ms（500 ms 宽限 + 300 ms 等待，之后放弃）+ 接入服务收尾 ≤ 150 ms ≈ 1.3 s，其余约 0.7 s 留给 `/stop` Lambda 冷启动和真实网络。
- 不可中断工具不需要「停止中」状态：所有等待都有上限，超过上限就放弃，工具调用记为 failure；停止控件保持可点击，重复点击是幂等的。

## 与真实环境的差异（需在后续任务中复核）

| 项 | 本 spike | 真实环境 | 复核位置 |
|---|---|---|---|
| 信号存储 | DynamoDB Local（同一 Docker 网络，读 P50 约 5 ms，强一致语义由单节点天然满足） | 区域内 DynamoDB 强一致 `GetItem` 通常为个位数到十几毫秒，存在长尾；按请求计费。+25 ms 变体用于覆盖这一差异 | 13.8、端到端冒烟 |
| 两个 Lambda 调用 | 常驻进程（相当于热 Lambda） | `/stop` 可能落在冷启动的执行环境上，冷启动发生在计时起点之后 | 12.7、端到端冒烟 |
| 适配层 → 接入服务 | 本地 HTTP SSE | 经 `InvokeAgentRuntime` 数据面转发，事件传递延迟未测 | 13.8、端到端冒烟 |
| 交接标志 | 适配层接受调用后立即写 `: accepted` 注释，接入服务以首字节判定交接 | AgentCore 是否立即向调用方转发首字节未验证（与任务 1.4 的 heartbeat 相关） | 1.4、13.5 |
| 取消对适配层的调用 | 关闭 HTTP 连接，适配层据此不再调用模型 | 接入服务取消 `InvokeAgentRuntime` 后容器内调用是否被取消未验证；设计上依赖适配层开始时的 RUNCTL 检查兜住 | 13.5 |
| 运行时 | Node v22.23.3 | 正式实现同为 Node.js 22，AbortController / fetch（undici）/ `process.kill(-pgid)` 行为可直接迁移 | 13.3 |

# Spike 09：长连接、microVM 回收与令牌过期下官方 Web UI 的行为

对应 tasks.md 任务 1.9（Requirements 2.9、3.8、5.3）。复用 Spike 06 阶段 3 的部署（CloudFront + Cognito + JWT + 隧道 Lambda + AgentCore，模拟模型）。结论已写回 `.kiro/specs/poc/design.md`。

## 结论

| 问题 | 结果 |
|---|---|
| **AgentCore `/ws` 单帧上限** | **64 KB**，两个方向都有，超限时以 1009「message size limit of 64 KB for a message frame is exceeded」关闭。会话历史稍长时，刷新页面后 DSH 一次推送 72 KB 的历史快照，连接反复被关闭，界面显示「历史加载失败：Remote stream WebSocket closed」。**适配器改为分片发送（48 KB 续帧）后恢复正常。** 限制作用于帧而不是消息：分两帧发送 70 KB 可以通过，单帧 70 KB 会被拒绝（`results/big-frame.json`） |
| **WebSocket 连接时长** | AgentCore 对每条连接有 **1 小时上限**，到时以 1008「Max connection duration of 1 hour is exceeded」关闭。直连与经 CloudFront 都一样（EC2 实测 3626–3632 s，`results/ec2-ws-probe.json`） |
| 只有 WebSocket、没有 HTTP 调用时会不会被空闲回收 | 不会。只保持 WebSocket（适配器每 20 s 发 ping）的会话存活了 60 分钟，远超 900 s 的空闲超时 |
| StopRuntimeSession 时页面打开着 | 连接断开，DSH_Web 显示「自动重连中…」，约 1 s 内重新连上；不刷新即可继续对话；刷新后历史仍在（S01–S03，需要分片修复） |
| `maxLifetime=300` 到期 | 第 307 s 断开并立即重连；不刷新可以继续对话，刷新后历史仍在（M01、M02） |
| 令牌过期（有效期 5 分钟） | 已建立的 WebSocket **继续可用**（浏览器与原始 WS 都多保持了 9 分钟：AgentCore 只在握手时验签）。但发送消息走的是 HTTP `POST /api/session/prompt`，返回 401，**界面没有任何提示**；刷新页面会跳转到 `/auth/login`（T01–T04）。因此设计中加入了隧道 Lambda 的滑动续期 |
| JWT 授权的 Runtime 上调用 StopRuntimeSession | 必须用 Bearer 令牌调用 `POST /runtimes/<arn>/stopruntimesession`；SigV4 调用返回 `Authorization method mismatch` |

### 本机长连接测试为什么不可信

在 WSL / Windows 本机保持连接时，出现过两次「所有连接同时断开」：
- 第 11 分钟：浏览器页面与原始 WS 同时断开。
- 第 17.5 分钟：直连 AgentCore 的连接与经 CloudFront 的连接同时断开。

同一时段，向 S3 上传代码包也出现了 EOF 与空闲超时错误。断开同时发生在两条互不相关的 AWS 路径上，而同区域 EC2 上的同一实验在 1 小时内一次也没断，所以判定为本机网络抖动，不是 AgentCore 的行为（`results/L-run.log`、`results/ws-duration.json`）。

### 分片问题的定位过程

1. 刷新后连接反复被关闭；在本机环境（无 AgentCore）复现同样的流程，没有这个问题（`results/X-local-restart.json`）。
2. 给适配器加上 `ws closed` 日志（记录哪一侧先关闭、关闭码、原因），日志中出现 `closedBy: client, code: 1009, reason: Policy violated: message size limit of 64 KB …`。
3. 适配器加上 `sendFragmented` 后，日志显示 `ws message fragmented {bytes: 72678, frames: 2}`，S03 通过，且没有再出现 1009。

## 目录与运行

| 文件 | 作用 |
|---|---|
| `src/run.mjs` | 阶段 L（长保持、Stop、对照）、M（`maxLifetime`）、T（令牌过期）的编排；通过 Spike 06 的 `cloud/setup.sh` 切换 Runtime 与 App Client 配置（`MAX_LIFETIME`、`IDLE_TIMEOUT`、`TOKEN_VALIDITY_MINUTES`） |
| `ui/long.mjs` | Windows 侧 Edge 用例：`hold`、`watch`、`expire` 三种模式，记录 WebSocket 打开与关闭、页面提示、对话结果 |
| `src/ws-duration.mjs` | 本机四条连接对照（直连与 CloudFront、有无客户端 ping、有无 HTTP） |
| `ec2/run-ec2.sh`、`ec2/ws-probe.mjs` | 在同区域 t4g.micro 上运行同样的四条连接，时长 75 分钟，结果上传 S3 后实例自行终止。令牌通过 user-data 传入：它们只有 60 分钟有效期，且只在测试账号中使用 |
| `src/big-frame.mjs` | 60 KB 单帧、70 KB 单帧、70 KB 分两帧 |
| `src/local-restart.mjs` | 本机对照：后端重启后刷新页面 |

```bash
# 前置：Spike 06 aws/build.sh、aws/setup.sh、cloud/setup.sh 已执行；Windows 侧 C:\Users\zhang\spike07-ui 已安装 playwright-core@1.63.0
cd spikes/09-longlived && npm install
PHASES=L HOLD_MIN=1 node src/run.mjs     # Stop / 对照 / 短保持
PHASES=M,T node src/run.mjs              # maxLifetime 到期与令牌过期（会两次改动 Runtime 配置，最后恢复）
node src/big-frame.mjs
bash ec2/run-ec2.sh 75                   # 约 80 分钟后到 S3 取 results/ws-probe-*.json；结束后删除角色 dsh-poc-spike-09-ec2
```

## 对 Spike 06 代码的改动

- `src/adapter/index.mjs`：
  - 发往 AgentCore 的大消息分片发送（`WS_FRAME_MAX`，默认 48 KB）；
  - 新增 `ws closed` 日志。
- `cloud/setup.sh`：
  - 支持 `TOKEN_VALIDITY_MINUTES`、`MAX_LIFETIME`、`IDLE_TIMEOUT`（`idle` 必须 ≤ `maxLifetime`，否则 `UpdateAgentRuntime` 会报错）；
  - 代码包上传失败时重试 4 次。
- `aws/setup.sh`：支持 `MAX_LIFETIME`、`IDLE_TIMEOUT`。

## AWS 资源

以下资源已于 2026-09-27 删除，并逐类核对无残留：
- 用 Spike 06 的 `cloud/cleanup.sh` + `aws/cleanup.sh` 删除了分发、函数、缓存策略、Lambda、用户池、Runtime、桶、角色。
- EC2 实例均已终止；实例角色 `dsh-poc-spike-09-ec2` 已删除。

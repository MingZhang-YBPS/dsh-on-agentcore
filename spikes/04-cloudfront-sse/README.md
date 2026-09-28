# Spike 04：CloudFront + Lambda Function URL 的 SSE 链路验证

对应 tasks.md 任务 1.4（Requirements 1.5、3.4、3.13、5.3）。结论已回写 `.kiro/specs/poc/design.md`，涉及以下章节：
- 「需求中的量化约束落点」
- 「1. DSH_Web」
- 「2. 接入服务」：HTTP 接口、SSE 事件协议、超时预算
- 「3. 认证与授权流程」
- 「6. 会话调用完整时序」
- Error Handling
- 配置参数
- `WebConstruct`
- 风险表

## 验证内容

1. SSE 能否逐事件到达、CloudFront 有没有额外缓冲：同一组事件分别经 CloudFront 和直连 Function URL（SigV4 签名，作为基线）发送，逐事件记录到达时间。
2. `/api/*` 行为使用 CachingDisabled；Origin Request Policy 使用 `AllViewerExceptHostHeader`，检查查询串与自定义头是否原样转发。
3. OAC 对 Function URL 做 SigV4 签名时，与用户的 `Authorization: Bearer` 是否冲突。分别测 `always` 与 `no-override` 两种签名行为，以及 POST 请求的 `x-amz-content-sha256` 要求。
4. 源响应超时（Response timeout）的两种语义：首字节等待与包间空闲。另测 heartbeat 能否维持长时间静默的流、GET 与 POST 在超时后是否被重试，以及 CloudFront 断开后源站 Lambda 的行为。

## 运行

依赖：bash、aws CLI v2、Node.js ≥ 22、npm、python3（仅标准库）、zip。区域取自 `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure`。

```bash
./run-all.sh          # 创建 → 用例 → 清理（EXIT trap 保证清理）。CloudFront 创建与删除各 5–15 分钟，整体约 30 分钟
# 或分步执行（用例失败时可以保留资源重跑）
./setup.sh
node src/run_tests.mjs      # → results/cases.jsonl、events-*.json、summary.md，约 6 分钟
./cleanup.sh
```

本地调试：设置 `SPIKE_CF_BASE` / `SPIKE_FN_BASE` 把请求指向本地模拟源站，`SPIKE_ONLY` 按用例 ID 正则筛选，`SPIKE_SKIP_LOGS=1` 跳过 CloudWatch 统计。

创建的资源（均带 `dsh-poc-spike-04-` 前缀，tag `purpose=dsh-poc-spike-04`）：

| 资源 | 说明 |
|---|---|
| IAM 角色 `…-lambda-role` | `AWSLambdaBasicExecutionRole` |
| Lambda `…-sse` + Function URL | nodejs22.x / arm64，`AuthType=AWS_IAM`、`InvokeMode=RESPONSE_STREAM`；资源策略只允许本分发（`lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`，`SourceArn` 限定） |
| OAC `…-always`、`…-nooverride` | `OriginAccessControlOriginType=lambda` |
| 缓存策略 `…-authz` | 缓存键含 `Authorization`，只供 no-override 行为使用 |
| CloudFront 分发 | 四个源指向同一个 Function URL：`o30`（always，Response timeout 30，默认行为）、`o60`（always，60，`/t60/*`）、`onoov`（no-override，`/noov/*`）、`onone`（无 OAC，`/nooac/*`）。配置见 `src/cf-config.mjs` |

## 实测结果（us-east-1，2026-09-26，边缘节点 SFO53，临时资源已删除并核实）

33 个用例全部符合预期。完整表格见 `results/summary.md`，逐事件到达时间见 `results/events-*.json`。

**请求头、查询串与 OAC 鉴权**

| 用例 | 结果 |
|---|---|
| H01 GET，带 `Authorization: Bearer`、`x-dsh-token`、`x-request-id` 与含 `%2B`、`%2F`、空值的查询串 | 200。查询串逐字节原样到达；自定义头原样到达；源站 event 里**没有** `Authorization`：OAC 用自己的 SigV4 替换了它，Lambda 验签后也不把它放进 event。源站额外收到 `x-amz-date`、`x-amz-security-token`、`x-amz-content-sha256`、`x-amz-source-arn`、`x-amz-source-account` 与 `cloudfront-viewer-*` |
| H02 POST 带正确的 `x-amz-content-sha256` | 200，源站收到的请求体 sha256 一致 |
| H03 / H04 POST 不带或带错误的 `x-amz-content-sha256` | 403 `InvalidSignatureException`，源站调用 0 次 |
| H05 / H05b 空请求体 POST，带或不带空串 sha256 | 都是 200 |
| H06 无请求体 DELETE | 200 |
| H07 no-override 签名，viewer 带 `Authorization: Bearer`（已加入缓存键） | 403 `AccessDeniedException`，源站调用 0 次：Function URL 把 Bearer 当作 SigV4 校验 |
| H08 no-override，viewer 不带 `Authorization` | 200（CloudFront 代签） |
| H09 源未配置 OAC / H10 直连 Function URL 不签名 | 403 / 403：无法绕过 CloudFront |
| H11 同一 GET 连发两次 | 两次都回源（两个不同的 requestId），`x-cache` 无 Hit |

**逐事件到达**（相对滞后 = 以首个事件为基准，到达间隔减去发送间隔，可消除本机与 Lambda 的时钟偏差）

| 用例 | 路径 | 相对滞后 p50 / p95 / 最大 (ms) | 响应头到达 (ms) |
|---|---|---|---|
| S01 20 事件 × 250 ms | CloudFront / 直连 | −10 / 30 / 30 ；−14 / 32 / 32 | 408 / 951 |
| S02 200 小事件 × 20 ms | CloudFront / 直连 | 10 / 57 / 260 ；0 / 112 / 253 | 595 / 634 |
| S02p 50 个 4 KB 事件 × 50 ms | CloudFront | −21 / 170 / 271 | 614 |

- CloudFront 与直连基线处于同一量级，最大滞后都在 300 ms 以内，没有观察到 CloudFront 额外缓冲。滞后主要来自本机（WSL）到 us-east-1 的网络抖动；另一轮运行中，S01 的最大滞后在 CloudFront 与直连上分别是 233 / 493 ms。
- 响应没有 `content-encoding`，即使请求带 `Accept-Encoding: gzip, br`；`content-type: text/event-stream` 原样保留。
- 事件到达间隔最小为 0 ms：小事件有时会在网络层合并到同一个数据块，因此前端解析器必须按 `\n\n` 切分，不能假设一个数据块对应一个事件。

**超时与 heartbeat**

| 用例 | 行为 |
|---|---|
| S03 POST 首字节 25 s（Response timeout 30） | 正常完成 |
| S04 POST 首字节 35 s（30） | 30.5 s 时返回 504；源站只调用 1 次（POST 不重试） |
| S04g GET 首字节 35 s（30） | 90.8 s 时才返回 504；源站被调用 **3 次**（GET 按 `ConnectionAttempts=3` 重试，每次都跑满 35 s） |
| S05 已发响应头与 `: accepted`，随后静默 35 s（30） | 约 30.9 s 时连接被切断，客户端收到 `UND_ERR_SOCKET`，不是正常结束 |
| S05m 3 个事件之后静默 35 s（30） | 同上，已到达的 3 个事件不受影响 |
| S06 已发响应头，静默 70 s，期间每 10 s 一次 heartbeat 注释（30） | 正常完成 |
| S07 首字节 45 s（Response timeout 60） | 正常完成 |
| S08 已发响应头，静默 65 s（60） | 约 60.8 s 时被切断 |
| S09 持续 180 s，每 10 s heartbeat（30） | 正常完成，没有总时长上限（未设置 Response completion timeout） |
| R03 被切断或返回 504 时源站 Lambda 的视角（S04、S05、S05m、S08） | `responseStream` 上**没有** `close` / `error` 事件，之后的写入也不报错，函数照常运行到结束 |

- 本账号「Response timeout per origin」配额的当前值是 120 s（Service Quotas `L-AECE9FA7`）；文档给出的默认值是 30 s，默认最大 60 s。
- Lambda 流式响应的一个实现陷阱：`awslambda.HttpResponseStream.from(...)` 之后直接 `end(body)`，Function URL 返回 502 `Internal Server Error`，而函数日志中没有任何错误。先 `write(body)` 再 `end()` 才正常。只改成等待 `finish` 事件不能解决。

## 结论

- **用户令牌不能放在 `Authorization` 头**：
  - `always` 签名会覆盖该头，Lambda 也不会把它交给函数。
  - `no-override` 会让 Function URL 按 SigV4 校验 Bearer，返回 403。
  - 结论：浏览器把访问令牌放在自定义头 `X-Dsh-Authorization: Bearer <jwt>` 中，由 `AllViewerExceptHostHeader` 转发；OAC 保持 `always`；Function URL 保持 `AWS_IAM`，只允许本分发调用。
- **非空请求体的 POST 必须带 `x-amz-content-sha256`**（请求体的十六进制 SHA-256），否则被 Function URL 以 403 拒绝，而且到不了函数。前端 API 客户端用 `crypto.subtle.digest` 计算。空请求体的 POST 与 DELETE 不需要这个头。
- **流式响应需要 heartbeat**：
  - Response timeout 同时约束「首字节等待」与「包间空闲」。
  - 接入服务在调用 Runtime 之前立即下发响应头与首个注释帧，之后只要 10 s 内没有发出任何帧，就发一次 `: heartbeat` 注释；Response timeout 保持默认 30 s，不需要申请配额。
  - 用户可见的等待（Runtime 冷启动、工作空间恢复、模型首 token、长工具调用）都不再受 CloudFront 超时约束。
- **CloudFront 断开时源站不会得到通知**：函数照常运行到结束。因此接入服务的收尾（写助手消息、RUNCTL 置 idle）不依赖连接状态。前端在连接异常中断（非 `message_completed` 结束）时按连接中断处理，重新拉取历史。
- **非流式 GET 必须在 30 s 内返回**：否则 CloudFront 会重试源站最多 3 次，用户要等约 90 s 才看到 504。接入服务的 GET 路由设置 10 s 内部预算（健康检查 5 s）。POST 不会被重试，不存在重复生成的风险。

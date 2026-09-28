# Spike 06：官方 DSH Web UI 经隧道运行在 AgentCore Runtime 上

验证架构调整后的方案：前端直接用官方 `dsh web`（`@deepseek-ai/dsh@0.1.5-rc.3`，不自建 UI）。每个用户对应一个 AgentCore
runtimeSessionId（`dsh-user-<Cognito sub>`），使用托管 session storage 持久化，并通过 Cognito 登录。

结论：可行。三个阶段共 63 个用例全部符合预期。需要知道的限制见文末「已知限制」。

## 架构

```
浏览器 ──HTTPS──> CloudFront ──默认行为（viewer-request: cf-default-function.js）──> 隧道 Lambda（Function URL, AuthType NONE + X-Origin-Verify）
   │                    │                                                              │ 从 cookie dsh_token 取 Cognito 访问令牌
   │                    │                                                              └─> AgentCore InvokeAgentRuntime /invocations（Bearer，JWT 授权器）
   │                    └─/api/remote.mux（viewer-request: cf-ws-function.js）──> AgentCore /runtimes/<arn>/ws（Authorization: Bearer，会话 ID 走查询参数）
   │
   └─ /auth/login：Lambda 用 AdminInitiateAuth 换访问令牌，写 HttpOnly cookie
                                                                                         ↓
                              microVM（每个 runtimeSessionId 一个）：适配器 :8080（src/adapter）
                                ├─ 会话归属校验：会话 ID 必须等于 dsh-user-<JWT.sub>（REQUIRE_SESSION_OWNER=1）
                                ├─ POST /invocations：拆封包（src/lib/envelope.mjs）→ 127.0.0.1:3080 dsh web
                                ├─ /ws ↔ dsh web /api/remote.mux（适配器自己完成 token→cookie 交换，每 20 s ping）
                                ├─ SigV4 签名代理（模型调用；本 spike 用 MOCK_MODEL=1 的模拟上游）
                                └─ HOME=/mnt/workspace（托管 session storage）；DSH_HOME 在 /tmp，每 2 s 镜像到 /mnt/workspace/.dsh
```

- 封包格式：
  - 请求是 JSON `{v,method,path,headers,body(b64)}`。
  - 响应第一行是一行 JSON `{v,status,headers}\n`，后面紧跟原始响应体，流式返回。SSE 与大文件都原样透传。
- 加固补丁 `dsh/web-hardening.cordis.yml` 关闭以下内容：
  - 设置写入、模型/插件设置页、插件清单；
  - 遥测、LLM 生成会话标题、HMR（包括 `client-hmr` 那条长连接 EventSource）；
  - DeepSeek 专用行、`open-in-app`。
  - `ui-settings` / `ui-settings-general` 关不掉：它们提供 `settingsScope`，有 30 个客户端插件依赖。`web` 行也关不掉：`tool-web` 依赖它。

## 目录

| 路径 | 作用 |
|---|---|
| `src/adapter/` | 容器内适配器 `index.mjs`、DSH_HOME 镜像 `home-mirror.mjs` |
| `src/lib/` | 封包、模拟模型上游（标记 `[[TEXT\|TOOL\|SLOW\|SLEEPTOOL\|STUBBORNTOOL]]`）、签名代理与外联记录代理 |
| `src/gateway/` | 阶段 1/2 用的本机网关：`localTransport` 直连本机适配器，`agentcore-transport.mjs` 用 SigV4 调 AgentCore |
| `src/test/` | `run_local.mjs`（阶段 1）、`run_agentcore.mjs`（阶段 2）、`run_cloud.mjs`（阶段 3）、`dev.mjs`（手工调试） |
| `ui/ui-suite.mjs` | 浏览器用例，在 Windows 侧 Edge 上用 playwright-core 1.63.0 运行（WSL 里没有浏览器依赖库） |
| `dsh/` | `web.cordis.yml`（接入签名代理、默认工作区）、`web-hardening.cordis.yml` |
| `aws/` | 阶段 2：`build.sh`（arm64 代码包）、`setup.sh`（桶、执行角色、Runtime + session storage）、`cleanup.sh` |
| `cloud/` | 阶段 3：`setup.sh`、`cleanup.sh`、`lambda/index.mjs`、两个 CloudFront Function |

## 运行

前置条件：
- WSL 原生文件系统（`sync.sh` 会把代码同步到 `~/spike06-run` 再运行）。
- Windows 侧装好 Edge，并在 `C:\Users\<you>\spike06-ui` 下执行过 `npm i playwright-core@1.63.0`（可用 `WIN_UI_DIR` 改路径）。
- 阶段 2/3 需要 AWS 凭证，默认 profile + 默认区域。

```bash
# 阶段 1：本机（适配器 + dsh web + 本机网关 + Edge）
./sync.sh node src/test/run_local.mjs          # → results/local-*

# 阶段 2：AgentCore（IAM SigV4 调用，本机网关）
./aws/build.sh && ./aws/setup.sh
./sync.sh bash -c 'cp -r /mnt/d/go/dsh-on-agentcore/spikes/06-webui-tunnel/.state . && node src/test/run_agentcore.mjs'   # → results/agentcore-*

# 阶段 3：CloudFront + Cognito + JWT（会把 Runtime 切到 JWT 授权器，此后阶段 2 的 SigV4 调用不再可用）
./cloud/setup.sh                               # 分发部署约 5–15 分钟；测试用户口令随机生成，只写入 .state/cloud-secrets.env（0600）
./sync.sh bash -c 'cp -r /mnt/d/go/dsh-on-agentcore/spikes/06-webui-tunnel/.state . && node src/test/run_cloud.mjs'      # → results/cloud-*

# 清理：先 cloud 再 aws（后者会删除 .state/）
./cloud/cleanup.sh && ./aws/cleanup.sh
```

## 实测结果（us-east-1，2026-09-26/27）

### 阶段 1：本机，23/23（`results/local-summary.md`）

- 适配器启动到 dsh web 就绪约 6.6 s。页面加载 1.4 s。
- 停止生成：点击到按钮消失 64 ms，到模型上游的连接被关闭。
- 重启后会话列表与历史恢复，继续对话时模型请求带有重启前的历史。
- 加固后，`settings/*` 与 `credentials/*` RPC 返回 404，设置面板中没有模型、插件、凭证页。
- 全程没有非回环外联。

### 阶段 2：AgentCore Runtime，18/18（`results/agentcore-summary.md`）

| 项 | 结果 |
|---|---|
| 冷启动（microVM + 挂载 session storage + dsh web 启动） | 7.9–11.4 s；适配器在 DSH 就绪前挂起请求，不返回 503 |
| 热会话单请求往返（WSL → us-east-1） | P50 约 430 ms，P95 928 ms |
| 同一会话 30 个并发调用 | 30/30 成功 |
| 页面加载 / 文本回复 / 停止生成 | 5.9 s / 1.4 s / 519 ms |
| WebSocket 空闲保持 | 180 s 不断（依赖适配器每 20 s 的 ping） |
| StopRuntimeSession 后恢复 | 收到 SIGTERM 并完成最后一次镜像同步；再次访问 10.6 s，旧会话可以继续 |

### 阶段 3：CloudFront + Cognito + JWT，22/22（`results/cloud-summary.md`）

- 入口：
  - 未登录访问 `/` 返回 303 跳转登录页；口令错误返回 401 且不下发 cookie。
  - 绕过 CloudFront 直连 Function URL 返回 403；未登录调用 `/api/*` 返回 401。
  - 未登录连接 `/api/remote.mux` 时，CloudFront Function 返回 401。
- 经 CloudFront 的完整 UI 流程全部通过：选工作区、文本对话 1.4 s、工具调用、停止生成 0.6–0.7 s、文件预览。登录加首页完全加载 5–10 s。
- 隔离：
  - bob 登录后看到的是自己的空白环境。
  - bob 的令牌加 alice 的会话 ID：`/invocations` 被适配器拒绝（内层 403）；`/ws` 被拒绝（AgentCore 返回 424）。
  - 无令牌或令牌被篡改时，JWT 授权器返回 401/403。
- 重复运行时，alice 的工作区、会话与文件从 session storage 恢复（U02 记为「已持久化」）。

## 踩过的坑（设计必须考虑）

1. **session storage 不支持硬链接。** DSH 发布会话文件用的是 `link()`，报错 `Unknown system error -524`。解决办法：`DSH_HOME` 放在本地 `/tmp`，每 2 s 镜像到 `/mnt/workspace/.dsh`（排除 `profiles/`）；启动时恢复，SIGTERM 时做最后一次同步。工作区里的 pnpm 等依赖硬链接的工具同样有风险。
2. **AgentCore `/ws` 空闲约 60 s 会以 1006 断开。** 适配器每 20 s 向 AgentCore 一侧发一次 ping。
3. **`/ws` 上请求头转发区分大小写。** `requestHeaderAllowlist=Authorization` 在 `/ws` 上只转发写成 `Authorization` 的头，小写的 `authorization` 会被丢掉，适配器因此返回 403，AgentCore 再报 424（C15 记录了这个行为）。`/invocations` 不受影响，CloudFront 转发时也没有问题。
4. **Lambda Function URL 拒绝以 `?` 开头的查询串。** DSH 插件包的 URL 形如 `/plugins/??a,b&rev=`，直接返回 400 `{"message":null}`，请求到不了函数。解决办法：`cf-default-function.js` 把查询串搬进 `x-dsh-raw-query` 头，再由 Lambda 还原。注意 CloudFront Function 里 querystring 对象的键顺序与原始 URL 不一致，必须把以 `?` 开头的键放在最前面。
5. **Lambda 响应流：`HttpResponseStream.from()` 之后至少要 `write` 一次。** 直接 `end(body)` 会得到 502；空响应体不 `write` 的话，状态码和头根本发不出去，Function URL 退回 `200 application/octet-stream`。
6. **CloudFront Function 手写 base64 循环会超出指令上限。** 报 `RangeError: Instruction limit exceeded`，改用 `cloudfront-js-2.0` 的 `Buffer`。
7. **浏览器不能直连 AgentCore。** 官方 UI 的 WebSocket 固定连 `location.origin/api/remote.mux`，既不能设置子协议也不能设置头，所以只能由 CloudFront Function 从 cookie 注入 `Authorization`。OAC 放在 Lambda 前面也不可行：DSH 客户端不会发送 `x-amz-content-sha256`。
8. **JWT 授权器不把会话 ID 与用户绑定。** 任何持有有效令牌的人都能调用任意会话 ID，所以容器内必须再做一次归属校验（`REQUIRE_SESSION_OWNER`）。
9. **构建代码包需要 `npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc --ignore-scripts`。**
   - 不加 `--ignore-scripts` 时，koffi 的安装脚本因为缺少 CMake 而失败。
   - 必须删掉 `node-pty/prebuilds` 中非 arm64 的文件以及 `.bin`：AgentCore 会检查包内每个 ELF 文件。
   - 结果：解压后 275 MB，zip 58 MB。

## 已知限制（带入 requirements/design）

- **session storage：**
  - 每个会话上限 1 GB；空闲 14 天后清除。
  - **Runtime 每更新一次版本，全部用户数据都会被清空**，升级前必须有导出/迁移方案。
  - 如果不能接受，退路是每用户一个 Runtime + EFS。
- **插件包没有缓存。** 首页要经 Lambda → AgentCore 拉取约 10.8 MB 的插件包，默认行为是 CachingDisabled。插件包与用户无关，可以考虑为 `/plugins/*` 单独配置可缓存的行为。
- **令牌：** 访问令牌存在 cookie 里，有效期 1 h，没有刷新流程，过期后需要重新登录。
- **设置面板：** 加固后打开设置面板会显示 settings/describe 的 404 提示。
- **web_search 不可用：** 没有 DeepSeek key。
- **未验证：** 真实 Bedrock 模型（本 spike 全程使用 `MOCK_MODEL=1`），即原任务 1.6。

## AWS 资源

全部带 `purpose=dsh-poc-spike-06` 标签或 `dsh-poc-spike-06` / `dsh_poc_spike_06` 前缀。2026-09-27 已用 `cloud/cleanup.sh` 与 `aws/cleanup.sh` 删除，并逐类核对过：Runtime、工作负载身份、分发、CloudFront Function、缓存策略、Lambda、IAM 角色、用户池、桶、日志组均无残留。

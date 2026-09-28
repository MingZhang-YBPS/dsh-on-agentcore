# Spike 05：锁定 DSH 版本并验证无界面集成接口

对应 tasks.md 任务 1.5（Requirements 1.5、3.1、3.4、3.5）。结论已回写 `.kiro/specs/poc/design.md`：关键决策表、「4. DSH 适配层」（镜像结构、DSH 驱动与适配层对外契约、停止生成）、风险表，并新增决策点 D3（前端形态）。

## 锁定的版本

| 项 | 值 |
|---|---|
| npm 包 | `@deepseek-ai/dsh@0.1.5-rc.3`。它是 npm `latest` dist-tag 所指的版本，`next` 为 0.1.7-rc.2。`package-lock.json` 锁定全部 521 个依赖 |
| 源码 | `deepseek-ai/deepseek-harness` tag `dsh-v0.1.5-rc.3`，commit `a4c74a91e06b00fe0b0937bde982170c526cc842`，MIT 许可 |
| 运行环境 | Node `^22.19.0 \|\| >=24.0.0`，glibc Linux |
| 原生依赖 | 锁文件里有 linux-arm64 的可选包（`@deepseek-ai/node-addon-system-linux-arm64`、`node-addon-require-builtin-linux-arm64-gnu`、`@koromix/koffi-linux-arm64`、`@img/sharp-linux-arm64`），`node-pty` 自带 linux-arm64 prebuild。`node-addon-require-builtin` 没有 musl 变体，所以基础镜像**不能用 Alpine** |

DSH 目前处于 developer preview，每个版本都可能不兼容，因此必须锁定版本：
- 同一个桥接插件在 0.1.7-rc.2 上，D01–D09 都能通过。
- 但注入历史上下文的 D10 会失败，报错 `format v4 message requires a producer-owned source kind`：0.1.7 的会话格式 v4 要求插件注册自己的消息来源类型。

## 验证内容与方式

适配层一侧的驱动（`src/driver.mjs`）以子进程方式启动 `dsh --profile headless --patch bridge/bridge.cordis.yml`，通过 Node IPC 与自研的 Cordis 插件 `bridge/dsh-agentcore-bridge.mjs` 通信。

- 模型请求发往适配层进程内的 SigV4 签名代理，由它转发给本地模拟的 OpenAI 兼容上游（`src/mock-upstream.mjs`）。
- DSH 进程的 `HTTP(S)_PROXY` 指向一个外联记录代理（`src/proxies.mjs`），用来发现任何非回环外联。
- 全程不调用任何云服务或 DeepSeek 服务。

```bash
./run.sh      # npm ci + node src/run_tests.mjs → results/cases.jsonl、upstream-requests.jsonl、summary.md
```

在 WSL 的 `/mnt/<盘符>` 下运行时，`run.sh` 会先把 spike 复制到 `$HOME` 下的临时目录再跑：经 DrvFs 加载 500 多个包时，DSH 启动约需 32 s，原生 ext4 上约 1.1 s。

## 实测结果（本机 WSL2 原生 ext4，linux-x64，Node v24.21.0，2026-09-26）

14 个用例全部符合预期，见 `results/summary.md`。

| 用例 | 结果 |
|---|---|
| D01 / D01w 启动 | spawn 到桥接插件就绪 1.0–1.2 s，首次启动（需初始化 `DSH_HOME`）与再次启动相差不大 |
| D02 文本流式 | 模型的 5 个 `content` 片段对应 5 个 `delta` 事件，一一对应且文本逐字相等；2 个 `reasoning_content` 片段单独作为 reasoning 流；本机首个 delta 约 230 ms |
| D03 请求形态 | `POST {baseURL}/chat/completions`，请求体字段为 `model`、`messages`、`stream: true`、`stream_options.include_usage`、`store: false`、`max_completion_tokens: 8192`、`tools`（23 个 OpenAI function 工具）。没有 `thinking`、`dsh_*` 等 DeepSeek 私有字段。这些字段是否被 Bedrock 接受，由任务 1.6 验证 |
| D04 签名注入 | DSH 发出占位 `Authorization: Bearer`（适配器要求必须有密钥），签名代理丢弃它并重新签名，上游收到 `AWS4-HMAC-SHA256`（scope `us-east-1/bedrock/aws4_request`），`x-amz-content-sha256` 与请求体一致。DSH（pi-ai 基于 OpenAI SDK）还会附带 `x-stainless-*` 头 |
| D05 工具调用 | `bash` 工具在 cwd（即工作空间）内写文件、建目录。`tool/call` 事件带名称与原始 JSON 参数，`tool/result` 事件带 `isError` 与输出文本 |
| D06 同进程多轮 | 下一轮请求自动带上此前全部轮次，包括 assistant 的 `tool_calls` 与 `tool` 结果 |
| D07 流式中途取消 | `agent.cancel({kind:'user'})` 之后 5–14 ms 收到 `turn/end{aborted, user}`；到上游的 HTTP 连接被提前关闭；已生成的部分作为 `assistant/message{interrupted:true}` 提交 |
| D08 工具执行中取消 | 3–7 ms 收到 `turn/end{aborted}`；前台进程与后台孙进程（同一进程组）200 ms 内全部消失 |
| D08b 忽略 SIGTERM 的工具 | 桥接补丁把 `bash-sandbox.graceMs` 设为 500 后，取消到进程被 SIGKILL 清除用时 526 ms（DSH 默认宽限期为 3000 ms） |
| D09 关闭 | IPC `shutdown` → SIGTERM → 约 50 ms 以退出码 0 退出 |
| D10 新进程注入上下文 | 在新进程的首轮用 `agent.inject()` 注入一条 `source: {kind:'plugin', form:'recall'}` 的上下文消息，它出现在模型请求中，位于本轮用户消息之前 |
| D11 持久化位置 | DSH 只写 `DSH_HOME`：`profiles/`（含 482 个指向安装目录的依赖软链接）、`sessions/<项目>/<会话>/session.v3.jsonl.zstd`、`storages/session_projcache/`。工作空间里只有工具写入的文件 |
| D12 外联 | 0 次。桥接补丁关闭了默认会上报到 `harness-telemetry.deepseeksvc.com` 的遥测、标题生成 LLM 调用、DeepSeek 官方适配器、`web_search`/`web_fetch` 工具 |

## 六项接口结论

1. **启动方式**：以子进程运行 `dsh --profile headless --patch <桥接补丁>`，cwd 设为 `/workspace`，并设置以下环境变量：
   - `DSH_HOME`：指向不持久化的可写目录
   - `DSH_PERMISSION_MODE=danger-full-access`
   - `DSH_TELEMETRY_DISABLED=1`

   不采用的方式：
   - `sdk` 协议：没有取消方法，也不转发 token 级增量。
   - `acp` 协议：可以取消，但只按已提交的消息推送，不是 token 级。
   - 进程内 `boot()`：不是公开 API，而且会接管宿主进程的信号与 stdout。
2. **插件配置**：补丁文件按行覆盖（整行替换 `config`，不做深合并），可以 `disabled: true` 关闭行，也可以 `insert` 新行。`insert` 中的相对路径插件名按补丁文件所在目录解析，所以桥接插件不需要安装进 DSH 的 profile。需要关闭的行及原因见 `bridge/bridge.cordis.yml`。
3. **事件接口**：
   - token 级增量只有进程内事件 `agent/assistant-stream` 提供（`text-delta`、`reasoning-delta`、`tool-call-delta`）。
   - 工具调用与轮次结束来自持久化事件 `session/event`（`tool/call`、`tool/result`、`assistant/message`、`turn/end`）。
   - 这两类事件都只能由进程内插件订阅，这正是需要自研桥接插件的原因。
4. **工具调用协议**：
   - 采用 OpenAI function calling（`tools[].function`、流式 `tool_calls` 增量、`role: tool` 回灌）。
   - bash 工具每次以独立进程组（detached）启动。取消时对整组发 SIGTERM，经过 `graceMs` 后发 SIGKILL。前台默认超时 120 s（上限 600 s）。
   - 在 `danger-full-access` 模式下，审批策略为 `never`，不会出现阻塞等待人工确认的情况。
5. **工作空间路径**：工作空间根就是 DSH 进程的 cwd（`sandbox-policy.workspaceRoot: process.cwd()`，会话元数据 `meta.cwd`）。DSH 自己的会话日志等状态只写 `DSH_HOME`，不写工作空间。
6. **自定义 base URL 与请求签名**：
   - 用 `llm-pi-ai` 的 `openai-completions` 路由即可设置任意 `baseURL`。
   - 两个模型适配器都没有自定义 fetch 或逐请求签名钩子，只能配置静态头。`llm-pi-ai` 对手工声明的 `bedrock-converse-stream` 路由会明确拒绝，理由是配置形状无法表达 SigV4。
   - 结论：`baseURL` 指向适配层进程内的 127.0.0.1 签名代理，由代理完成 SigV4 签名并流式转发。
   - `llm-deepseek` 会发送 `thinking`、`dsh_*` 等私有字段，不用于 Bedrock。

## 决策点 D3（需用户确认）：DSH_Web 用自建 SPA 还是复用官方 Web 插件

- **推荐：自建 SPA**（现设计）。依据如下：
  - **身份模型**：官方 Web UI 是单用户设计，没有用户身份。它的鉴权是启动时打印的一次性 token 换 HMAC cookie，只允许在 127.0.0.1 或 0.0.0.0 上监听，也没有 TLS。
  - **暴露面过大**：它向浏览器开放设置、凭证、模型配置等 API，工作空间文件读取也不受工作空间根限制。
  - **与 AgentCore 的调用模型不匹配**：它依赖一个长驻的 HTTP + WebSocket 服务。AgentCore Runtime 的 HTTP 协议契约只有 `/invocations` 与 `/ping`，把任意 HTTP 或 WebSocket 请求转进 microVM 的做法没有验证过。
  - **与持久化需求不匹配**：它展示的是 DSH 自己在 `DSH_HOME` 中的会话历史，而 microVM 回收后这份历史就会丢失，满足不了 4.x 的跨会话历史与 5.x 的工作空间持久化，这两项仍需要本设计的存储层。
- **备选：复用官方 Web 插件**。这需要：
  - 每个 AgentCore 会话一个 DSH Web 进程；
  - 在接入服务里实现 HTTP/WebSocket 反向代理（先验证 AgentCore 是否支持）；
  - 处理 Host 白名单与 bootstrap token；
  - 关闭设置、凭证等面板。

  好处是获得完整的官方交互（计划、目标、子代理、附件等）。但历史与工作空间持久化仍需另行实现，而且要跟随 DSH 频繁的不兼容升级。

## 未验证项

- 在 linux-arm64 容器（AgentCore 的实际运行架构）内安装与运行：本机无法使用 Docker。锁文件已包含 arm64 原生包，镜像构建时的首次验证放在任务 13.7。
- 真实 Bedrock 端点能否接受 D03 中的请求体字段（`store`、`max_completion_tokens`、`stream_options`），以及 SigV4 签名：放在任务 1.6。
- microVM 内是否存在用户级 systemd。bash 工具在有 systemd 时会改用 `systemd-run --user --scope` 管理进程；本机按进程组路径验证。

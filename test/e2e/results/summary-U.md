# 端到端阶段 U 结果

- 运行：2026-09-28T05:15:33.197Z；runId c637d4；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v5；模型 deepseek.v3.2
- 用例 16，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| U00 |  | 回收 alice 的 microVM（StopRuntimeSession） | 200 {} | 记录 |
| U01 | alice | 页面加载：无意外的控制台错误与失败请求，建立 1 条 /api/remote.mux WebSocket；插件包经缓存行为返回且不带 Set-Cookie | 登录+首页 11699 ms；重新加载 4913 ms；WebSocket 1；插件请求 首次 Hit from cloudfront/Hit from cloudfront，重新加载 Hit from cloudfront/Hit from cloudfront（命中 2）；Set-Cookie=false | ✓ |
| U02 | alice | 关闭内测声明，选择 ~/workspace 作为工作区（重复运行时已持久化） | 已从上次运行持久化 | ✓ |
| U14 | alice | 模型：新会话中可在模型下拉切到 Bedrock deepseek.v3.2 对话，再切回 DeepSeek-V4.1-Flash | 新会话当前「DeepSeek-V4.1-Flash」回复 1970 ms；新会话切到 deepseek.v3.2 回复 1797 ms；切回「DeepSeek-V4.1-Flash」 | ✓ |
| U15 | alice | 记录行为：同一会话中途从 DeepSeek 官方切到 Bedrock deepseek.v3.2 | 切换后回复正确（1726 ms） | ✓ |
| R02 | alice | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 3444 ms；新增「DeepSeek-V4.1-Flash High 1 轮 1 步·190 tok/s 8.2K tok·缓存命中 97%」 | ✓ |
| R03 | alice | 工具调用：模型调用 bash 在工作空间写 hello.txt 并报告输出；界面显示工具调用，展开后无原始标记 | 发送→结束 4933 ms；工具调用=true；原始标记=false | ✓ |
| R04 | alice | 多轮上下文：追问上一轮工具输出 | 发送→结束 3454 ms；新增「eepSeek-V4.1-Flash High 3 轮 4 步·266 tok/s 33.4K tok·缓存命中 97%」 | ✓ |
| U06 | alice | 文件预览：右侧边栏文件树列出 hello.txt，点击后显示本次写入的内容 | 预览显示 dsh-e2e-c637d4 | ✓ |
| R05 | alice | 停止生成：长回复流式输出中点击「停止生成」，按钮消失且之后页面不再追加内容 | 开始输出 2945 ms；点击→停止 731 ms；停止后 1 s 页面文本 573 字，再过 5 s 573 字 | ✓ |
| U12 | alice | 令牌过期续期：把 dsh_token 换成已过期的令牌后不刷新继续对话；隧道用刷新令牌续期，页面不中断 | 回复 2391 ms；cookie 已换成新令牌=true；URL / | ✓ |
| U13 | alice | 大历史刷新：约 80 KB 的用户消息使历史快照超过 AgentCore 64 KB 单帧上限，刷新后仍完整加载 | 消息 89 KB，回复 2435 ms；刷新后历史可见=true；刷新后收到的最大 WebSocket 消息 222 KB | ✓ |
| U10 | bob | 另一用户：看不到 A 的会话、文件内容与提示词 | 检查 4 个标记，均不可见 | ✓ |
| D01 | alice | 并发对话：与另一用户同时各发 3 条消息，全部得到回复 | 模型「DeepSeek-V4.1-Flash」；回复 1862 / 1667 / 1701 ms | ✓ |
| D01 | bob | 并发对话：与另一用户同时各发 3 条消息，全部得到回复 | 模型「DeepSeek-V4.1-Flash」；回复 1749 / 1911 / 1858 ms | ✓ |
| U16 | bob | 未切换过模型的用户，新会话使用部署的默认模型（配置了 DeepSeek key 时为 DeepSeek-V4.1-Flash） | bob 新会话「DeepSeek-V4.1-Flash」，期望「DeepSeek-V4.1-Flash」 | ✓ |
| U10b | bob | 并发对话之后再次检查：bob 仍看不到 alice 的内容 | 检查 4 个标记，均不可见 | ✓ |

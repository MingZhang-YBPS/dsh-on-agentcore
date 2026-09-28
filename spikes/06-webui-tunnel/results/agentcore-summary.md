# Spike 06 阶段 2（AgentCore）结果摘要

- 运行时间：2026-09-26T14:16:42.818Z；区域 us-east-1；Runtime arn:aws:bedrock-agentcore:us-east-1:271547278201:runtime/dsh_poc_spike_06_web-3xbLmuFPpk；runtimeSessionId dsh-user-5e8708509155109c89cfe6b9
- 用例 18，不符合预期 0

| 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|
| A01 | 新会话首个请求（microVM 冷启动 + 挂载 session storage + dsh web 启动） | 8122 ms，status 200 | ✓ |
| A02 | 热会话单个请求往返（本机 → us-east-1 → microVM → dsh web） | 423 ms | ✓ |
| A03 | 同一会话 30 个并发 InvokeAgentRuntime | 成功 30/30，总耗时 1323 ms，单个 P50 920 ms / 最大 1319 ms | ✓ |
| A04 | 响应字节原样穿过隧道（静态文件） | favicon 3721 B，manifest 267 B | ✓ |
| U01 | 页面经隧道加载：无控制台错误、无失败请求、建立 1 条 /api/remote.mux WebSocket | 加载 5932 ms，20 个请求 | ✓ |
| U02 | 关闭内测声明，经目录选择器选择 ~/workspace 作为工作区 |  | ✓ |
| U03 | 文本对话：发送后助手回复逐段渲染完成 | 发送→回复出现 1396 ms | ✓ |
| U04 | 工具调用：bash 在工作空间写文件，界面显示工具调用与后续回复 | 发送→完成 963 ms | ✓ |
| U05 | 停止生成：新会话慢速流式中点击「停止生成」，按钮消失、后续片段不再到达 | 点击→停止控件消失 519 ms，停止时最后一片 片17，5 秒后 片17 | ✓ |
| U06 | 文件预览：右侧边栏文件树列出工作空间文件，点击 hello.txt 显示内容 | 预览显示 spike05 | ✓ |
| A05:settings/describe | 加固补丁下经隧道直接调用 settings/describe 被拒绝 | status 404 | ✓ |
| A05:credentials/set | 加固补丁下经隧道直接调用 credentials/set 被拒绝 | status 404 | ✓ |
| A06 | WebSocket 经 AgentCore /ws 连接后空闲保持 180 s（不发业务消息） | {"opened":751,"stillOpenAfterMs":180004,"pings":8} | ✓ |
| A07 | StopRuntimeSession 后再次访问（新 microVM + 恢复 session storage + dsh web 启动） | 10606 ms | ✓ |
| U07 | DSH 进程重启后（同一持久目录）：会话列表与历史仍在，可在旧会话继续对话 | 旧会话历史可见；继续对话回复 1081 ms | ✓ |
| U08 | 加固补丁下：页面可用、可新建会话对话；失败请求只有被关闭的 settings/describe | 回复 943 ms；失败请求 2 个（均为 settings/describe=true） | ✓ |
| U09 | 加固补丁下：设置面板里没有模型/插件/凭证配置页 | 设置入口=true；页面含「插件」=false「API Key」=false「凭证」=false | ✓ |
| A08 | InvokeAgentRuntime 调用统计（本机 WSL → us-east-1） | 共 141 次，P50 435 ms，P95 928 ms，最大 10602 ms；网关错误 0 | ✓ |

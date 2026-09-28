# Spike 06 阶段 1（本机）结果摘要

- 运行时间：2026-09-27T03:58:00.665Z；DSH @deepseek-ai/dsh@0.1.5-rc.3；浏览器：Windows 侧 Edge（headless）
- 用例 23，不符合预期 0

| 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|
| L01 | 适配器启动到 dsh web 就绪（spawn、token 换 cookie、/ping 变为 Healthy） | 9632 ms | ✓ |
| U01 | 页面经隧道加载：无控制台错误、无失败请求、建立 1 条 /api/remote.mux WebSocket | 加载 2163 ms，22 个请求 | ✓ |
| U02 | 关闭内测声明，经目录选择器选择 ~/workspace 作为工作区 |  | ✓ |
| U03 | 文本对话：发送后助手回复逐段渲染完成 | 发送→回复出现 979 ms | ✓ |
| U04 | 工具调用：bash 在工作空间写文件，界面显示工具调用与后续回复 | 发送→完成 422 ms | ✓ |
| U05 | 停止生成：新会话慢速流式中点击「停止生成」，按钮消失、后续片段不再到达 | 点击→停止控件消失 124 ms，停止时最后一片 片12，5 秒后 片12 | ✓ |
| U06 | 文件预览：右侧边栏文件树列出工作空间文件，点击 hello.txt 显示内容 | 预览显示 spike05 | ✓ |
| L02 | 工具写入的文件落在持久目录的 ~/workspace 下 | /tmp/spike06-local-gPn8Rg/home/workspace/hello.txt | ✓ |
| L03 | 停止生成后到模型上游的连接被关闭 | clientClosedEarly=true | ✓ |
| L04 | 未加固时，经网关可直接调用 settings/describe（说明需要加固） | status=200 ok=false | ✓ |
| L05 | 阶段 A 期间 DSH 进程无非回环外联 | 0 次 | ✓ |
| L06 | 隧道请求统计（本机，不含 AgentCore 开销） | HTTP 56 个，WS 1 条，错误 0，P50 31 ms，P95 152 ms | ✓ |
| L07 | 重启后 dsh web 就绪（同一持久目录，cookie 签名密钥与会话日志已存在） | 9822 ms | ✓ |
| U07 | DSH 进程重启后（同一持久目录）：会话列表与历史仍在，可在旧会话继续对话 | 旧会话历史可见；继续对话回复 550 ms | ✓ |
| L08 | 重启后在旧会话继续对话：模型请求包含重启前的历史（DSH 从 JSONL 恢复会话） | 请求中用户消息 4 条 | ✓ |
| L09 | 加固补丁下 dsh web 能启动 | 9433 ms | ✓ |
| U08 | 加固补丁下：页面可用、可新建会话对话；失败请求只有被关闭的 settings/describe | 回复 579 ms；失败请求 2 个（均为 settings/describe=true） | ✓ |
| U09 | 加固补丁下：设置面板里没有模型/插件/凭证配置页 | 设置入口=true；页面含「插件」=false「API Key」=false「凭证」=false | ✓ |
| L10:settings/describe | 加固后经 /api 直接调用 settings/describe 被拒绝 | status=404 ok=null "not found" | ✓ |
| L10:settings/update | 加固后经 /api 直接调用 settings/update 被拒绝 | status=404 ok=null "not found" | ✓ |
| L10:credentials/describe | 加固后经 /api 直接调用 credentials/describe 被拒绝 | status=404 ok=null "not found" | ✓ |
| L10:credentials/set | 加固后经 /api 直接调用 credentials/set 被拒绝 | status=404 ok=null "not found" | ✓ |
| L11 | 全程 DSH 进程无非回环外联 | 0 次 | ✓ |

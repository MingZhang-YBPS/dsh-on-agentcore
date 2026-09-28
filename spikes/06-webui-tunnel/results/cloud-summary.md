# Spike 06 阶段 3（CloudFront + Cognito + AgentCore JWT）结果摘要

- 运行时间：2026-09-27T02:15:43.640Z；分发 d2p7f1fl3ms30c.cloudfront.net；Runtime arn:aws:bedrock-agentcore:us-east-1:271547278201:runtime/dsh_poc_spike_06_web-3xbLmuFPpk
- 用例 22，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| C01 |  | 未登录访问 / → 303 跳转登录页 | 303 → /auth/login | ✓ |
| C02 |  | 口令错误 → 401 登录页，不下发 cookie | 401 | ✓ |
| C03 |  | 绕过 CloudFront 直连 Lambda Function URL（无源头密钥）→ 403 | 403 | ✓ |
| C04 |  | 未登录调用 /api/* → 401 | 401 | ✓ |
| C05 |  | 未登录连接 /api/remote.mux → CloudFront Function 返回 401 | {"result":"rejected","status":401} | ✓ |
| U01 | alice | 页面经隧道加载：无控制台错误、无失败请求、建立 1 条 /api/remote.mux WebSocket | 加载 5158 ms，44 个请求 | ✓ |
| U02 | alice | 关闭内测声明，经目录选择器选择 ~/workspace 作为工作区 | 工作区已从上次运行持久化，无需重新选择 | ✓ |
| U03 | alice | 文本对话：发送后助手回复逐段渲染完成 | 发送→回复出现 1418 ms | ✓ |
| U04 | alice | 工具调用：bash 在工作空间写文件，界面显示工具调用与后续回复 | 发送→完成 1375 ms | ✓ |
| U05 | alice | 停止生成：新会话慢速流式中点击「停止生成」，按钮消失、后续片段不再到达 | 点击→停止控件消失 696 ms，停止时最后一片 片16，5 秒后 片16 | ✓ |
| U06 | alice | 文件预览：右侧边栏文件树列出工作空间文件，点击 hello.txt 显示内容 | 预览显示 spike05 | ✓ |
| C06 |  | 经 CloudFront 登录耗时（含 Cognito AdminInitiateAuth 与首页冷启动） | 9730 ms | ✓ |
| U10 | bob | 另一用户登录后看到的是自己的空白环境：没有他人的会话与工作区 | 会话列表为「暂无会话」 | ✓ |
| C07 |  | bob 的有效令牌 + alice 的会话 ID 直接调用 AgentCore /invocations → 适配器 403 | AgentCore 200，内层 403 | ✓ |
| C08 |  | 对照：alice 令牌 + alice 会话 ID 直接调用 → 200 | AgentCore 200，内层 200 | ✓ |
| C09 |  | 不带令牌直接调用 AgentCore → 被 JWT 授权器拒绝 | 401 {"jsonrpc":"2.0","error":{"code":-32001,"message":"Missing Authentication Token"}} | ✓ |
| C10 |  | 签名被篡改的令牌 → 被 JWT 授权器拒绝 | 401 | ✓ |
| C11 |  | bob 令牌 + alice 会话 ID 直连 AgentCore /ws → 被拒绝或立即关闭 | {"result":"rejected","status":424} | ✓ |
| C12 |  | 对照：alice 令牌 + alice 会话 ID 直连 /ws → 保持打开 | {"result":"open"} | ✓ |
| C15 |  | 记录行为：直连 /ws 时小写 authorization 不会被转发给容器 → 失败即关闭（424） | {"result":"rejected","status":424} | ✓ |
| C13 |  | 不带令牌直连 /ws → 被拒绝 | {"result":"rejected","status":403} | ✓ |
| C14 |  | 会话 ID 由令牌主体派生，两名用户互不相同 | alice=dsh-user-a4081418-2021-70b3-2846-a59b9ae835e4 bob=dsh-user-34888468-6051-7025-a798-04120b18ae3d | ✓ |

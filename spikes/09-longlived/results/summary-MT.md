# Spike 09 结果摘要（长连接、microVM 回收、令牌过期）

- 运行时间：2026-09-27T07:09:59.223Z；分发 df073xoeev9f0.cloudfront.net

| 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|
| M01 | maxLifetime=300 s 到期：打开着的页面 WebSocket 关闭并自动重连（刷新前） | 关闭 #0@307s，新开 #1@307s；全程打开 #0@15s #1@307s #2@457s；提示 ["自动重连中..."] | ✓ |
| M02 | 到期回收后：不刷新继续对话 / 刷新后历史与对话 | 不刷新 ok 1707 ms；刷新后历史=true 回复 ok 1288 ms | ✓ |
| T00 | 新签发令牌有效期 | 299 s | 记录 |
| T01 | 令牌过期后，已建立的 WebSocket 是否继续可用 | 关闭 无；原始 WS {"openedMs":8340,"closedMs":540022,"code":1006,"reason":"","msgs":0,"pings":26,"error":null,"stillOpenAtEnd":true} | 记录 |
| T02 | 令牌过期后不刷新直接对话 | FAIL 60336 ms page.waitForFunction: Timeout 60000ms exceeded. | 记录 |
| T03 | 令牌过期后 HTTP 请求与刷新页面 | HTTP 错误 401 /api/session/prompt@509s；导航 /auth/login@2s /@8s /auth/login@569s；刷新后 URL /auth/login | ✓ |
| T04 | 令牌过期后界面提示 | ["登录"] | 记录 |

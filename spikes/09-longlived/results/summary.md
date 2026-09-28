# Spike 09 结果摘要（长连接、microVM 回收、令牌过期）

- 运行时间：2026-09-27T04:38:55.011Z；分发 df073xoeev9f0.cloudfront.net

| 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|
| S01 | StopRuntimeSession 后打开着的页面：WebSocket 关闭并自动重连（刷新前） | Stop=200 {}；go@37s 之后关闭 无，新开 无；全程打开 #0@6s #1@26s #2@282s #3@284s #4@286s；提示 ["历史加载失败：api gateway: Remote stream WebSocket closed（gateway/internal）"] | ✗ |
| S02 | 回收后不刷新页面继续对话 | ok 1576 ms  | ✓ |
| S03 | 回收后刷新页面：历史可见、可继续对话 | 历史=true；回复 FAIL | ✗ |
| L01 | 浏览器页面保持 1 分钟：WebSocket 是否中断 | 打开 #0@6s；关闭 无；结束前 wsOpen=1；提示 [] | ✓ |
| L02 | 保持 1 分钟后不刷新直接对话 | ok 1178 ms | ✓ |
| L03 | 原始 WebSocket（只连接不发消息，令牌 60 分钟过期）保持 3 分钟 | {"openedMs":1182,"closedMs":180022,"code":1006,"reason":"","msgs":0,"pings":8,"error":null,"stillOpenAtEnd":true} | ✓ |

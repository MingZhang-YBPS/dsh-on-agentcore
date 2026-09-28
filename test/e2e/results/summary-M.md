# 端到端阶段 M 结果

- 运行：2026-09-27T12:47:13.485Z；runId 9dbc19；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v1；模型 deepseek.v3.2
- 用例 3，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| M01 |  | 回收后打开着的页面：WebSocket 关闭并自动重连（刷新前） | 等待 maxLifetime=300 s 到期（观察 7 分钟）；关闭 #0@306s，新开 #1@307s | ✓ |
| M02 |  | 回收后不刷新页面继续对话 | ok 5324 ms  | ✓ |
| M03 |  | 回收后刷新页面：历史可见、可继续对话 | 历史=true；回复 ok 3119 ms | ✓ |

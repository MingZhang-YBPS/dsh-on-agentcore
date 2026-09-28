# 端到端阶段 S 结果

- 运行：2026-09-28T05:21:54.047Z；runId c637d4；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v5；模型 deepseek.v3.2
- 用例 3，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| S01 |  | 回收后打开着的页面：WebSocket 关闭并自动重连（刷新前） | StopRuntimeSession 200 {}；关闭 #0@38s，新开 #1@38s | ✓ |
| S02 |  | 回收后不刷新页面继续对话 | ok 2733 ms  | ✓ |
| S03 |  | 回收后刷新页面：历史可见、可继续对话 | 历史=true；回复 ok 2482 ms | ✓ |

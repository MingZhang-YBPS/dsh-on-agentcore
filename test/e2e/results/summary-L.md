# 端到端阶段 L 结果

- 运行：2026-09-27T14:05:21.893Z；runId 2fec7c；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v2；模型 deepseek.v3.2
- 用例 2，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| L01 |  | 页面保持 70 分钟：记录 WebSocket 关闭（AgentCore 1 小时上限） | 关闭 #0@3663s(3647s)；打开 #0@16s #1@3663s | 记录 |
| L02 |  | 每次关闭之后页面都自动重新连接 | 关闭 1，打开 2 | ✓ |
| L03 |  | 保持 70 分钟后不刷新直接对话 | ok 3296 ms | ✓ |

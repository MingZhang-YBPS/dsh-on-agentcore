# 端到端阶段 P 结果

- 运行：2026-09-28T05:26:30.931Z；runId d1cd05；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v5；模型 deepseek.v3.2
- 用例 6，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| W01 | alice | 写入：新会话中调用 bash 在工作空间写 hello.txt（内容带本次 runId） | 发送→结束 4568 ms；输出含 dsh-e2e-d1cd05=true | ✓ |
| P0S |  | StopRuntimeSession（运维用户的 Bearer 令牌） | 200 {} | ✓ |
| P01 | alice | microVM 回收后重新打开：冷启动内加载完成，写入时的会话在列表中且历史可见 | 登录→首页可用 11513 ms；会话「e2e-d1cd05-alice 请调用」历史可见（含 dsh-e2e-d1cd05） | ✓ |
| P02 | alice | 回收后 hello.txt 仍在：右侧边栏预览显示写入的内容 | 预览显示 dsh-e2e-d1cd05 | ✓ |
| P03 | alice | 回收后在新会话继续对话 | 回复 2365 ms | ✓ |
| P04 |  | 新 microVM：DSH_HOME 从 session storage 恢复，适配器启动到 DSH 就绪的耗时 | 05:25:06 final home mirror sync {"copied":17}；05:25:38 home restore {"restored":5,"ms":43}；05:25:43 dsh web ready {"readyMs":4975} | ✓ |

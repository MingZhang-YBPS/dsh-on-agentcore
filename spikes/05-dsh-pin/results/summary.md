# Spike 05 结果摘要

- DSH：@deepseek-ai/dsh@0.1.5-rc.3；Node v24.21.0 linux-x64；运行时间 2026-09-26T12:44:50.115Z
- 用例 14，不符合预期 0

| 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|
| D01 | 启动：spawn dsh@0.1.5-rc.3 --profile headless --patch bridge.cordis.yml 到桥接插件就绪 | 1188 ms，provider=bedrock model=us.deepseek.r1-v1:0 | ✓ |
| D02 | 文本回复：token 级 delta 与上游片段一一对应，reasoning_content 单独成流 | 5 个 delta、2 个 reasoning，首个 delta 246 ms | ✓ |
| D03 | 模型请求形态：路径、请求体字段、工具声明（OpenAI tool calling） | 字段 model,messages,stream,stream_options,store,max_completion_tokens,tools；工具 23 个 | ✓ |
| D04 | 签名注入：DSH → 本地签名代理（占位 Bearer）→ SigV4 签名后到达上游 | 上游看到 AWS4-HMAC-SHA256 scope=us-east-1/bedrock/aws4_request，SignedHeaders=accept;accept-encoding;accept-language;content-type;host;x-amz-content-sha256;x-amz-date;x-stainless-arch;x-stainless-lang;x-stainless-os;x-stainless-package-version;x-stainless-retry-count;x-stainless-runtime;x-stainless-runtime-version | ✓ |
| D05 | 工具调用：bash 工具在工作空间（cwd）内执行，tool/call 与 tool/result 事件可映射 | 工具 bash，结果 isError=false，文件 已写入 | ✓ |
| D06 | 同一 DSH 进程内的下一轮：请求自动带上此前轮次（含工具调用与结果） | 消息角色序列 system,user,user,assistant,user,assistant,tool,assistant,user | ✓ |
| D07 | 流式生成中途取消：取消 → turn_end(aborted) 的耗时、上游连接被关闭、部分内容标记 interrupted | 取消→turn_end 11 ms，reason={"kind":"aborted","reason":{"kind":"user"}}，上游连接提前关闭=true | ✓ |
| D08 | 工具执行中取消：前台 sleep 61 与后台孙进程 sleep 62 所在进程组被终止 | 取消→turn_end 3 ms；200 ms 后残留 sleep61=0 sleep62=0；3.7 s 后残留 sleep61=0 sleep62=0 | ✓ |
| D08b | 忽略 SIGTERM 的工具（bash-sandbox.graceMs=500）：取消后多久进程组被 SIGKILL 清除 | 取消→turn_end 504 ms；取消→sleep 63 消失 526 ms | ✓ |
| D09 | 关闭：IPC shutdown → 进程退出 | 54 ms，exit=0 | ✓ |
| D01w | 启动（DSH_HOME 已初始化，相当于镜像构建时预热）：spawn 到桥接插件就绪 | 1038 ms | ✓ |
| D10 | 新 DSH 进程首轮：agent.inject 注入的历史上下文出现在模型请求中，且位于本轮用户消息之前 | 用户角色消息 3 条，上下文位于第 1 条 | ✓ |
| D11 | DSH 自身持久化只落在 DSH_HOME（会话 JSONL、设置、配置文件），不写工作空间 | DSH_HOME：profiles/node_modules 下 482 个依赖链接，其余 23 项（会话 JSONL、投影缓存、profile）；工作空间只有工具写入的文件 | ✓ |
| D12 | 外联：DSH 进程没有尝试访问任何非回环地址（遥测、DeepSeek 官方 API 等均已关闭） | 0 次外联尝试 | ✓ |

# Spike 07 AgentCore（真实 Bedrock 模型）结果摘要

- 运行时间：2026-09-27T03:50:41.292Z
- 用例 20，不符合预期 0

| 轮次 | 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| A   | A00 | 切换 Runtime 模型配置（update-agent-runtime → READY） | 27871 ms，version 2 | ✓ |
| A bedrock-runtime deepseek.v3.2 | R01 | 选择 ~/workspace 作为工作区 |  | ✓ |
| A bedrock-runtime deepseek.v3.2 | R02 | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 2137 ms（停止控件 711 ms）；新增「 发消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.v3.2 1 轮 1 步·185 tok/s 8.4K tok·缓存命中 0%」 | ✓ |
| A bedrock-runtime deepseek.v3.2 | R03 | 工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记 | 发送→结束 3835 ms；工具调用标记=true；展开后原始标记=false | ✓ |
| A bedrock-runtime deepseek.v3.2 | R04 | 多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息） | 发送→结束 1031 ms；新增「或对话 完全权限 deepseek.v3.2 3 轮 4 步·1671 tok/s 33.8K tok·缓存命中 25%」 | ✓ |
| A bedrock-runtime deepseek.v3.2 | R05 | 停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容 | 发送→数到 50：5194 ms；点击→停止控件消失 531 ms；停止时 63，5 秒后 63 | ✓ |
| A   | A01 | microVM 内签名代理用执行角色凭证调用模型：全部成功 | model call 4 次，200 4 次，非 200 0 次；DSH 取消 0 次；剥离原始标记 1 次；耗时 P50 1304 ms | ✓ |
| A   | A03 | InvokeAgentRuntime 统计（本机 → us-east-1） | 40 次，首个 10633 ms（冷启动），P50 444 ms，最大 10633 ms；网关错误 0 | ✓ |
| B   | A00 | 切换 Runtime 模型配置（update-agent-runtime → READY） | 35342 ms，version 3 | ✓ |
| B bedrock-mantle deepseek.v3.2 | R01 | 选择 ~/workspace 作为工作区 |  | ✓ |
| B bedrock-mantle deepseek.v3.2 | R02 | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 1194 ms（停止控件 570 ms）；新增「消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.v3.2 1 轮 1 步·3000 tok/s 8.3K tok·缓存命中 98%」 | ✓ |
| B bedrock-mantle deepseek.v3.2 | R03 | 工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记 | 发送→结束 2544 ms；工具调用标记=true；展开后原始标记=false | ✓ |
| B bedrock-mantle deepseek.v3.2 | R04 | 多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息） | 发送→结束 1504 ms；新增「件或对话 完全权限 deepseek.v3.2 3 轮 4 步·364 tok/s 33.8K tok·缓存命中 73%」 | ✓ |
| B bedrock-mantle deepseek.v3.2 | R05 | 停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容 | 发送→数到 50：2587 ms；点击→停止控件消失 504 ms；停止时 75，5 秒后 75 | ✓ |
| B   | A01 | microVM 内签名代理用执行角色凭证调用模型：全部成功 | model call 5 次，200 5 次，非 200 0 次；DSH 取消 1 次；剥离原始标记 1 次；耗时 P50 858 ms | ✓ |
| B   | A03 | InvokeAgentRuntime 统计（本机 → us-east-1） | 40 次，首个 7725 ms（冷启动），P50 436 ms，最大 7725 ms；网关错误 0 | ✓ |
| E   | A00 | 切换 Runtime 模型配置（update-agent-runtime → READY） | 34705 ms，version 4 | ✓ |
| E bedrock-runtime openai.gpt-oss-20b-1:0 | E01 | 模型不可用：对话界面显示错误，页面仍可用 | 显示错误=true；输入框可用=true；新增「ace 你好 刚刚 设置 你好 标准模式 对话 轨迹 系统提示词 你好 11:50 上下文注入 @deepseek-ai/dsh-system-prompt 本轮运行失败API 密钥无效 AUTH 发消息或创建任务, / 调用指令, @ 文件或对话 完全权限 openai.gpt-oss-20b-1:0 1 轮 1 步」 | ✓ |
| E   | A02 | 执行角色无权调用的模型被拒绝（最小权限生效），日志记录拒绝原因 | 401 {"error":{"message":"User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-07-exec-role/BedrockAgentCore-468eedc9-f2d1-4ad2-8d95-9e93daff68be is not authorized to perform: bedrock:InvokeModel on  | ✓ |
| E   | A03 | InvokeAgentRuntime 统计（本机 → us-east-1） | 29 次，首个 11539 ms（冷启动），P50 427 ms，最大 11539 ms；网关错误 0 | ✓ |

# Spike 07 本机（适配器 + 真实 Bedrock）结果摘要

- 运行时间：2026-09-27T03:41:29.412Z；区域 us-east-1
- 用例 27，不符合预期 0

| 组合 | 用例 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| bedrock-runtime-deepseek.v3.2 | R01 | 选择 ~/workspace 作为工作区 |  | ✓ |
| bedrock-runtime-deepseek.v3.2 | R02 | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 1632 ms（停止控件 231 ms）；新增「消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.v3.2 1 轮 1 步·2400 tok/s 8.4K tok·缓存命中 98%」 | ✓ |
| bedrock-runtime-deepseek.v3.2 | R03 | 工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记 | 发送→结束 3002 ms；工具调用标记=true；展开后原始标记=false | ✓ |
| bedrock-runtime-deepseek.v3.2 | R04 | 多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息） | 发送→结束 5977 ms；新增「件或对话 完全权限 deepseek.v3.2 3 轮 4 步·187 tok/s 33.9K tok·缓存命中 97%」 | ✓ |
| bedrock-runtime-deepseek.v3.2 | R05 | 停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容 | 发送→数到 50：2443 ms；点击→停止控件消失 87 ms；停止时 54，5 秒后 54 | ✓ |
| bedrock-runtime-deepseek.v3.2 | L01 | bash 工具写入的文件落在 ~/workspace | "spike07\n" | ✓ |
| bedrock-runtime-deepseek.v3.2 | L02 | 适配器日志中的上游错误 | 无 | ✓ |
| bedrock-runtime-deepseek.v3.2 | L04 | DSH 会话日志中没有模型原始标记（DSML） | 扫描 2 个文件；命中 0 | ✓ |
| bedrock-mantle-deepseek.v3.2 | R01 | 选择 ~/workspace 作为工作区 |  | ✓ |
| bedrock-mantle-deepseek.v3.2 | R02 | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 1486 ms（停止控件 246 ms）；新增「消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.v3.2 1 轮 1 步·2333 tok/s 8.4K tok·缓存命中 98%」 | ✓ |
| bedrock-mantle-deepseek.v3.2 | R03 | 工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记 | 发送→结束 3156 ms；工具调用标记=true；展开后原始标记=false | ✓ |
| bedrock-mantle-deepseek.v3.2 | R04 | 多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息） | 发送→结束 1187 ms；新增「件或对话 完全权限 deepseek.v3.2 3 轮 4 步·148 tok/s 33.9K tok·缓存命中 72%」 | ✓ |
| bedrock-mantle-deepseek.v3.2 | R05 | 停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容 | 发送→数到 50：2337 ms；点击→停止控件消失 73 ms；停止时 52，5 秒后 52 | ✓ |
| bedrock-mantle-deepseek.v3.2 | L01 | bash 工具写入的文件落在 ~/workspace | "spike07\n" | ✓ |
| bedrock-mantle-deepseek.v3.2 | L02 | 适配器日志中的上游错误 | 无 | ✓ |
| bedrock-mantle-deepseek.v3.2 | L04 | DSH 会话日志中没有模型原始标记（DSML） | 扫描 2 个文件；命中 0 | ✓ |
| bedrock-mantle-deepseek.v3.1 | R01 | 选择 ~/workspace 作为工作区 |  | ✓ |
| bedrock-mantle-deepseek.v3.1 | R02 | 文本对话：真实模型流式回复，页面无原始标记 | 发送→结束 1627 ms（停止控件 231 ms）；新增「消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.v3.1 1 轮 1 步·4667 tok/s 7.9K tok·缓存命中 17%」 | ✓ |
| bedrock-mantle-deepseek.v3.1 | R03 | 工具调用：模型调用 bash 写文件并报告输出，界面显示工具调用，无原始标记 | 发送→结束 1773 ms；工具调用标记=true；展开后原始标记=false | ✓ |
| bedrock-mantle-deepseek.v3.1 | R04 | 多轮上下文：追问上一轮工具输出（历史中含 assistant.tool_calls 与 role=tool 消息） | 发送→结束 836 ms；新增「或对话 完全权限 deepseek.v3.1 3 轮 4 步·4182 tok/s 31.9K tok·缓存命中 79%」 | ✓ |
| bedrock-mantle-deepseek.v3.1 | R05 | 停止生成：长回复中点击「停止生成」，按钮消失且之后不再追加内容 | 发送→数到 50：1680 ms；点击→停止控件消失 71 ms；停止时 64，5 秒后 64 | ✓ |
| bedrock-mantle-deepseek.v3.1 | L01 | bash 工具写入的文件落在 ~/workspace | "spike07\n" | ✓ |
| bedrock-mantle-deepseek.v3.1 | L02 | 适配器日志中的上游错误 | 无 | ✓ |
| bedrock-mantle-deepseek.v3.1 | L04 | DSH 会话日志中没有模型原始标记（DSML） | 扫描 2 个文件；命中 0 | ✓ |
| bedrock-runtime-deepseek.not-a-model | E01 | 模型不可用：对话界面显示错误，页面仍可用 | 显示错误=true；输入框可用=true；新增「 is invalid.","type":"invalid_request_error","param":null,"code":"validation_error"} INVALID_REQUEST 发消息或创建任务, / 调用指令, @ 文件或对话 完全权限 deepseek.not-a-model 1 轮 1 步」 | ✓ |
| bedrock-runtime-deepseek.not-a-model | L02 | 适配器日志中的上游错误 | 无 | ✓ |
| - | L03 | DSH 进程非回环外联（经外联记录代理） | 0 次 [] | ✓ |

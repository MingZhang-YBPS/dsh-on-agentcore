# 端到端阶段 G 结果

- 运行：2026-09-28T05:23:21.697Z；runId c637d4；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v5；模型 deepseek.v3.2
- 用例 8，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| G00 |  | 回收测试用户的 microVM（StopRuntimeSession），使用当前版本与当前 key 状态启动 | 200 {} | 记录 |
| G01 | carol | 设置面板有「插件」，没有「模型」 | 导航：设置 设置 通用设置 插件 Agent 预设 打开配置文件  | ✓ |
| G02 | carol | 插件页：插件配置（终端、Agent 循环、Subagent、网页搜索）与插件列表两个视图 | 四张卡片与两个视图都在 | ✓ |
| G03 | carol | 网页搜索卡片：API Key 由部署管理，不能在页面上填写 | 密钥已配置；输入框禁用=true；接口地址 http://127.0.0.1:<port>/anthropic/v1 | ✓ |
| G04 | carol | 修改终端命令超时并保存，刷新后仍在；恢复默认后回到默认值 | 原值 60000 → 保存 45000，刷新后 45000；恢复默认后 60000 | ✓ |
| G05 | carol | 修改网页搜索的接口地址：部署拒绝，页面提示「本部署没有接受这些值」 | 保存被拒绝，草稿保留 | ✓ |
| G06 | carol | 插件列表列出已加载的插件 | 「已启用」25 项，含 tool-bash=true | ✓ |
| G07 | carol | 对话中调用 web_search：经适配器的 DeepSeek 代理返回结果 | 17246 ms；工具「网页搜索」=true；无错误；外站链接 1 个（https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html） | ✓ |
| G08 |  | 网页搜索卡片的「已配置密钥」与部署的 secret 一致 | secret 已配置，卡片 已配置（卡片状态在 microVM 启动时确定） | ✓ |

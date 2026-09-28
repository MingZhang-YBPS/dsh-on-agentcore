# Spike 01：Cognito 认证失败计数方案验证

对应 tasks.md 任务 1.1（Requirements 2.2、2.11、2.12）。结论已回写 `.kiro/specs/poc/design.md`「3. 认证与授权流程」。

## 验证内容

1. PostAuthentication 在口令错误时是否触发
2. PreAuthentication 的触发时机（口令比对前/后、用户不存在、空值与超长输入、触发器抛错时的错误形态）
3. `PreventUserExistenceErrors=ENABLED` 下的错误形态（含 Cognito 内建连续失败锁定）
4. 附加：只开放 `ALLOW_ADMIN_USER_PASSWORD_AUTH` 的 App Client 能否阻止浏览器直连登录

## 运行

依赖：bash、aws CLI v2、python3（仅标准库）、zip。区域取自 `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure`，未配置时脚本直接退出。

```bash
./run-all.sh                                  # 创建 → 三组用例 → 拉日志 → 清理（EXIT trap 保证清理）
# 或分步执行
./setup.sh
python3 run_tests.py                          # 主用例 C01–C14、B01–B09 → results/cases.jsonl
SPIKE_SUITE=burst python3 run_tests.py        # 无间隔连续失败 R01–R13 → results/cases-burst.jsonl
SPIKE_SUITE=adminonly python3 run_tests.py    # 仅 Admin 流程客户端 A01–A02 → results/cases-adminonly.jsonl
python3 collect_logs.py                       # 默认 CASES_FILE=cases.jsonl
./cleanup.sh
```

创建的资源（均带 `dsh-poc-spike-` 前缀）：IAM 角色 `dsh-poc-spike-cognito-trigger-role`、Lambda `dsh-poc-spike-preauth` / `dsh-poc-spike-postauth` 及其日志组、User Pool `dsh-poc-spike-throttle-pool`（含 App Client 与测试用户）。`cleanup.sh` 按名称和 `.state/state.env` 双重定位删除，可重复执行。

测试用户口令在 `run_tests.py` 内随机生成，只保存在进程内存中；结果文件不含口令与令牌。

## 实测结果（us-east-1，临时资源已删除）

触发器调用次数来自两个探针 Lambda 的 CloudWatch 日志（`results/trigger-invocations*.jsonl`），按用例时间窗对齐（`ClientMetadata` 不会传给 Pre/PostAuthentication，实测为 `null`）。完整表格见 `results/summary*.md`。

| 用例 | 场景 | 返回 | PreAuth | PostAuth |
|---|---|---|---|---|
| C01 / C12 | 正确口令（USER_PASSWORD / ADMIN_USER_PASSWORD） | 成功，ExpiresIn=43200 | 1 | 1 |
| C02 / C13 | 口令错误 | `NotAuthorizedException: Incorrect username or password.` | 1 | **0** |
| C03 / C14 | 用户不存在 | 同上，逐字相同 | 1（`userNotFound=true`） | 0 |
| C04 / C05 | 用户名为空 / 口令为空 | `InvalidParameterException: Missing required parameter USERNAME/PASSWORD` | 0 | 0 |
| C06 / C07 | 用户名 65 / 129 字符 | `NotAuthorizedException: Incorrect username or password.` | 1 | 0 |
| C08 / C09 | 口令 129 / 257 字符 | 同上（进入了口令比对） | 1 | 0 |
| C10 / C11 | PreAuth 抛错，正确 / 错误口令 | `UserLambdaValidationException: PreAuthentication failed with error SPIKE_LOCKED.` | 1 | 0 |
| B01–B07 | 间隔约 2–4 秒连续失败 7 次 | 全部 `Incorrect username or password.` | 各 1 | 0 |
| B08 / B09 | 随后正确口令 | 成功 | 1 | 1 |
| R01–R08 | 无间隔连续失败 | `Incorrect username or password.` | 各 1 | 0 |
| R09、R11、R12 | 继续失败 | `NotAuthorizedException: Password attempts exceeded` | 各 1 | 0 |
| R13 | 内建锁定期内正确口令 | `NotAuthorizedException: Password attempts exceeded` | 1 | 0 |
| A01 | 仅 Admin 流程客户端，直调 USER_PASSWORD_AUTH | `InvalidParameterException: USER_PASSWORD_AUTH flow not enabled for this client` | 0 | 0 |
| A02 | 仅 Admin 流程客户端，AdminInitiateAuth | 成功 | 1 | 1 |

服务端耗时参考：成功登录时 PreAuth→PostAuth 间隔 154–478 ms（含触发器冷启动）。CLI 端到端 3.6–7.6 s 主要是 WSL 下 aws CLI 进程启动开销，不代表服务端延迟。

## 结论

- PostAuthentication 只在成功时触发，无法用于失败计数。
- PreAuthentication 在口令比对前触发，可以拒绝请求，但拒绝时返回 `UserLambdaValidationException` 且消息内嵌错误文本，与普通认证失败可区分。
- `PreventUserExistenceErrors` 能统一「用户不存在」与「口令错误」，但 Cognito 内建锁定（`Password attempts exceeded`）的消息不同、规则不可配置，且超长输入会进入口令比对。
- 选定方案：接入服务代理登录（`AdminInitiateAuth`）并自行记录失败与判定锁定，App Client 只开放 Admin 流程。无需修改需求。

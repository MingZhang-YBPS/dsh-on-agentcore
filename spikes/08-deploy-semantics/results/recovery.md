# S9 之后的手工恢复实验（2026-09-27 04:53–05:25 UTC）

以下实验在栈 `DshPocSpike08`（处于 S9a 之后的 `UPDATE_FAILED`，Runtime 版本 9，MARK=4）上手工执行。「版本 / MARK」取自 `get-agent-runtime`。

| 操作 | cdk 输出 | 栈状态 | 版本 / MARK |
|---|---|---|---|
| `cdk diff`（去掉失败资源 MustFail） | 显示 `[-] AWS::IAM::Role MustFail destroy` | UPDATE_FAILED | 9 / 4 |
| `cdk deploy`（同上） | 创建了变更集，但报告 `(no changes)`，0 s 完成 | **仍为 UPDATE_FAILED** | 9 / 4 |
| `cdk deploy --force` | 同样是 `(no changes)` | **仍为 UPDATE_FAILED** | 9 / 4 |
| `cdk rollback` | 回滚 20 s | UPDATE_ROLLBACK_COMPLETE | **10 / 2**（回到上一个稳定模板，又产生一个新版本） |
| `cdk deploy`（MARK=4，无失败资源） | 成功 | UPDATE_COMPLETE | 11 / 4 |

结论：失败资源本身从未被创建，所以 CloudFormation 认为「去掉它」不是变更。只修复失败原因、再部署，无法让栈离开 `UPDATE_FAILED`。必须先执行 `cdk rollback`（或 `aws cloudformation rollback-stack`）回到上一个稳定状态，再重新部署。每一步只要改动了 Runtime，都会产生新版本（清空 session storage 的次数随之增加）。

另外，S10（创建时失败 + `--no-rollback`）中，栈在 12:53:20（本地时间）就进入了 `CREATE_FAILED`，但 `cdk deploy` 直到约 25 分钟后才以退出码 1 返回（`deployMs` 1488701）。原因未查明。部署包装器不应只依赖 cdk 进程返回，还应轮询 `describe-stacks`，一旦发现 `*_FAILED` 就立即报告。

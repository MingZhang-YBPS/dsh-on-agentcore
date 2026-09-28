# Spike 08：IaC 下的 Runtime 版本、session storage 清空与部署失败语义

对应 tasks.md 任务 1.8（Requirements 1.3、1.4、1.8）。结论已写回 `.kiro/specs/poc/design.md`（「部署与卸载流程」、CDK 构件、已知限制与风险）。

## 做了什么

- `app.mjs` 是一个最小的 CDK 应用（aws-cdk-lib 2.271.0，CLI 2.1143.0），包含 Cognito User Pool、执行角色和 L1 `CfnRuntime`。
- Runtime 的配置与正式设计一致：NODE_22 直接代码部署、`sessionStorage`、`requestHeaderAllowlist=Authorization`、`customJwtAuthorizer`（`allowedClients`）、`lifecycleConfiguration`。
- 探针 agent `agent/app.js` 很小：往 session storage 写入和读取一个标记文件，并返回 microVM 的 boot_id、环境变量 `MARK`、代码修订号。
- 驱动脚本 `src/run.mjs` 每次只改一个属性就部署一次。每次部署后分两次读标记：部署后立即读（请求可能仍落在旧 microVM 上）；`StopRuntimeSession` 之后再读（强制启动新 microVM）。最后注入必然失败的资源。

```bash
./run.sh node src/run.mjs          # 在 ~/spike08-run 运行，约 20 分钟（另有 S10 的 cdk 等待）→ results/
./run.sh npx cdk destroy DshPocSpike08 --force
```

## 结果（us-east-1，2026-09-27）

见 `results/summary.md`、`results/recovery.md`。

| 变更 | 新版本 | session storage |
|---|---|---|
| 参数不变重复部署 | 否，cdk 报告 `(no changes)` | 保留 |
| 只 StopRuntimeSession | 否 | 保留，新 microVM 恢复了原数据 |
| 只改 Tags | **是** | **清空** |
| 只改 Description | **是** | **清空** |
| 只改环境变量 | **是** | **清空** |
| 只改 lifecycle 的空闲超时（900→901） | **是** | **清空** |
| 只改代码包 | **是** | **清空** |
| 更新失败 + 默认回滚 | **两个**（更新一次、回滚一次） | **清空**，栈状态 `UPDATE_ROLLBACK_COMPLETE` |
| 更新失败 + `--no-rollback` | 是，Runtime 停留在新配置上 | **清空**，栈状态 `UPDATE_FAILED` |

关键结论：

1. **`CfnRuntime` 的任何属性变更都会产生新版本，并清空所有会话的 session storage。** 标签和描述也不例外。所以数据清空保护只需要判断「`AWS::BedrockAgentCore::Runtime` 在 diff 里有没有变更」，不必区分改的是哪个属性。
2. **清空是惰性的。** 部署之后，仍在运行的 microVM 继续使用旧版本（旧环境变量、旧代码），数据也还在，直到它因为停止、空闲或到期被回收；再次调用时才拿到新版本和一个空的文件系统。所以「部署成功」不代表用户已经看到了数据丢失，丢失会在之后陆续发生。
3. **重复部署是幂等的：** 不产生新版本，数据保留（需求 1.3）。
4. **失败语义：**
   - 默认回滚能把配置恢复原样，但数据仍然会被清空两次（更新一次、回滚一次）。
   - `--no-rollback` 会让栈停在 `UPDATE_FAILED`，Runtime 保持失败前已完成的更新。之后**只修复失败资源再部署，cdk 会报告 `(no changes)`**，加 `--force` 也一样，栈始终离不开 `UPDATE_FAILED`。必须先执行 `cdk rollback`（这又会产生一个新版本）再部署（见 `results/recovery.md`）。
   - 名称冲突这类错误会被 CloudFormation 的部署前校验（Early validation）直接拦下，变更集不会执行，Runtime 也不会被修改。
5. **创建失败 + `--no-rollback`：** 其余资源（Runtime、User Pool、角色）保持 `CREATE_COMPLETE`，失败资源与原因在栈事件中可见；`cdk destroy` 能正常删除整个栈。但是 cdk 进程在栈进入 `CREATE_FAILED` 约 25 分钟后才返回，原因未查明。
6. **JWT 授权的 Runtime 上，`StopRuntimeSession` 也必须用 Bearer 令牌调用。** 用 SigV4 调用会返回 `Authorization method mismatch`。运维脚本需要一个能通过授权器的令牌。
7. **Runtime 的日志组由服务自动创建，删除栈时不会一并删除。** CDK 应当预先声明日志组，以便控制保留期和删除策略；否则卸载时需要单独删除。
8. `CfnRuntime` 创建耗时约 80 s，单属性更新约 60 s。

## AWS 资源

栈 `DshPocSpike08` 与 `DshPocSpike08Fail` 已删除。3 个 Runtime 日志组已手工删除。CDK 资产留在账号已有的 bootstrap 桶里（`CDKToolkit` 栈在本 spike 之前就已存在，未改动）。

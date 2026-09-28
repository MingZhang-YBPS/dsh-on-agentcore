# Spike 08 结果摘要（Runtime 版本与 session storage；部署失败语义）

- 运行时间：2026-09-27T05:17:46.424Z；区域 us-east-1；栈 DshPocSpike08

| 步骤 | 变更 | cdk 退出码 / no changes | 栈状态 | 版本 | 立即读（同 VM / MARK） | Stop 后读（MARK / 代码） | 清空 |
|---|---|---|---|---|---|---|---|
| S0 | CDK 创建栈（CfnRuntime：session storage + 请求头白名单 + JWT 授权器），写入标记 | 0 /  | CREATE_COMPLETE | →1 [1] |  | "v1-data"（ / ） |  |
| S1 | 参数不变重复部署 | 0 / true | CREATE_COMPLETE | 1→1 [1] | "v1-data"（true / 1） | "v1-data"（1 / r1） | false |
| S2 | 只 StopRuntimeSession（对照：同版本下恢复 session storage） | 0 / true | CREATE_COMPLETE | 1→1 [1] | "v1-data"（true / 1） | "v1-data"（1 / r1） | false |
| S3 | 只改标签（Tags.rev） | 0 / false | UPDATE_COMPLETE | 1→2 [1,2] | "v1-data"（true / 1） | null（1 / r1） | true |
| S4 | 只改 Description | 0 / false | UPDATE_COMPLETE | 2→3 [1,2,3] | "after-S3"（true / 1） | null（1 / r1） | true |
| S5 | 只改环境变量（MARK=2） | 0 / false | UPDATE_COMPLETE | 3→4 [1,2,3,4] | "after-S4"（true / 1） | null（2 / r1） | true |
| S6 | 只改 lifecycleConfiguration.idleRuntimeSessionTimeout（900→901） | 0 / false | UPDATE_COMPLETE | 4→5 [1,2,3,4,5] | "after-S5"（true / 2） | null（2 / r1） | true |
| S7 | 只改代码包内容（CODE_REV r1→r2） | 0 / false | UPDATE_COMPLETE | 5→6 [1,2,3,4,5,6] | "after-S6"（true / 2） | null（2 / r2） | true |
| S8 | 更新时失败，默认回滚（MARK=3 + 必然失败的资源） | 1 / false | UPDATE_ROLLBACK_COMPLETE | 6→8 [1,2,3,4,5,6,7,8] | "after-S7"（true / 2） | null（2 / r2） | true |
| S9a | 更新时失败，--no-rollback（MARK=4 + 必然失败的资源） | 1 / false | UPDATE_FAILED | 8→9 [1,2,3,4,5,6,7,8,9] | "after-S8"（true / 2） | null（4 / r2） | true |
| S9b | 从 UPDATE_FAILED 恢复：去掉失败资源再部署 | 0 / true | UPDATE_FAILED | 9→9 [1,2,3,4,5,6,7,8,9] | "after-S9a"（true / 4） | "after-S9a"（4 / r2） | false |
| S10 | 创建时失败，--no-rollback：已创建的资源保留，失败资源与原因可见 | 1 /  | CREATE_FAILED | → [] |  | null（ / ） |  |
| S10d | cdk destroy 删除 CREATE_FAILED 的栈 | 0 /  | ABSENT | → [] |  | null（ / ） |  |

**S8** 
- `DshPocSpike08 | 1/4 | 12:49:07 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: 2a7df345-e`
- `DshPocSpike08 | 1/4 | 12:49:07 PM | UPDATE_ROLLBACK_IN_PROG | AWS::CloudFormation::Stack | DshPocSpike08 The following resource(s) failed to create: [MustFail]. `
- `DshPocSpike08 | 12:49:07 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: 2a7df345-eff0-4a`
- `❌ DshPocSpike08 failed to deploy`
- `‣ DeploymentError: Resource updates failed:`
- ` HandlerErrorCode: InvalidRequest)`

**S9a** 
- `DshPocSpike08 | 1/4 | 12:50:42 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: 515ac34b-f`
- `DshPocSpike08 | 1/4 | 12:50:45 PM | UPDATE_FAILED | AWS::CloudFormation::Stack | DshPocSpike08 The following resource(s) failed to create: [MustFail]. `
- `DshPocSpike08 | 12:50:42 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: 515ac34b-f3f0-46`
- `❌ DshPocSpike08 failed to deploy`
- `‣ DeploymentError: Resource updates failed:`
- ` HandlerErrorCode: InvalidRequest)`

**S10** 资源：CDKMetadata:CREATE_COMPLETE，ExecRole372216D6:CREATE_COMPLETE，ExecRoleDefaultPolicyD94BCE3E:CREATE_COMPLETE，MustFail:CREATE_FAILED，PoolClient8A3E5EB7:CREATE_COMPLETE，PoolD3F588B8:CREATE_COMPLETE，Runtime:CREATE_COMPLETE
- `DshPocSpike08Fail | 6/8 | 12:53:19 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: ea88d4`
- `DshPocSpike08Fail | 6/8 | 12:53:20 PM | CREATE_FAILED | AWS::CloudFormation::Stack | DshPocSpike08Fail The following resource(s) failed to create: [MustFail]. `
- `DshPocSpike08Fail | 12:53:19 PM | CREATE_FAILED | AWS::IAM::Role | MustFail Resource handler returned message: "Invalid principal in policy: "AWS":"arn:aws:iam::000000000000:role/spike08-does-not-exist" (Service: Iam, Status Code: 400, Request ID: ea88d4fe-fbe`
- `❌ DshPocSpike08Fail failed to deploy`
- `‣ DeploymentError: Resource updates failed:`
- ` HandlerErrorCode: InvalidRequest)`

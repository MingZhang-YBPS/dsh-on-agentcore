| 用例 | 场景 | 流程 | 结果 | 错误码 | 错误消息 | PreAuth 调用 | PostAuth 调用 | PreAuth userNotFound |
|---|---|---|---|---|---|---|---|---|
| C01 | 正确口令 | USER_PASSWORD | SUCCESS |  |  | 1 | 1 | False |
| C02 | 口令错误 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| C03 | 用户不存在 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | True |
| C04 | 用户名为空 | USER_PASSWORD | ERROR | InvalidParameterException | Missing required parameter USERNAME | 0 | 0 | - |
| C05 | 口令为空 | USER_PASSWORD | ERROR | InvalidParameterException | Missing required parameter PASSWORD | 0 | 0 | - |
| C06 | 用户名 65 字符（不存在） | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | True |
| C07 | 用户名 129 字符 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | True |
| C08 | 口令 129 字符 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| C09 | 口令 257 字符 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| C10 | PreAuth 拒绝（模拟锁定）+ 正确口令 | USER_PASSWORD | ERROR | UserLambdaValidationException | PreAuthentication failed with error SPIKE_LOCKED. | 1 | 0 | False |
| C11 | PreAuth 拒绝（模拟锁定）+ 错误口令 | USER_PASSWORD | ERROR | UserLambdaValidationException | PreAuthentication failed with error SPIKE_LOCKED. | 1 | 0 | False |
| C12 | Admin 流程 正确口令 | ADMIN_USER_PASSWORD | SUCCESS |  |  | 1 | 1 | False |
| C13 | Admin 流程 口令错误 | ADMIN_USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| C14 | Admin 流程 用户不存在 | ADMIN_USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | True |
| B01 | 连续口令错误第 1 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B02 | 连续口令错误第 2 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B03 | 连续口令错误第 3 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B04 | 连续口令错误第 4 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B05 | 连续口令错误第 5 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B06 | 连续口令错误第 6 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B07 | 连续口令错误第 7 次 | USER_PASSWORD | ERROR | NotAuthorizedException | Incorrect username or password. | 1 | 0 | False |
| B08 | 连续失败后立即使用正确口令 | USER_PASSWORD | SUCCESS |  |  | 1 | 1 | False |
| B09 | 等待 20 秒后使用正确口令 | USER_PASSWORD | SUCCESS |  |  | 1 | 1 | False |

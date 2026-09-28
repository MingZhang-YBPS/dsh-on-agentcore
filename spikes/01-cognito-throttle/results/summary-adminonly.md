| 用例 | 场景 | 流程 | 结果 | 错误码 | 错误消息 | PreAuth 调用 | PostAuth 调用 | PreAuth userNotFound |
|---|---|---|---|---|---|---|---|---|
| A01 | 仅 Admin 流程的客户端：浏览器直调 USER_PASSWORD_AUTH | USER_PASSWORD | ERROR | InvalidParameterException | USER_PASSWORD_AUTH flow not enabled for this client | 0 | 0 | - |
| A02 | 仅 Admin 流程的客户端：接入服务 ADMIN_USER_PASSWORD_AUTH | ADMIN_USER_PASSWORD | SUCCESS |  |  | 1 | 1 | False |

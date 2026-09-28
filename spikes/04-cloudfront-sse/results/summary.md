# Spike 04 结果摘要

- 区域：us-east-1；分发：d26wgxov54hapj.cloudfront.net；运行时间：2026-09-26T11:53:31.684Z
- 用例 33，不符合预期 0

| 用例 | 说明 | 状态 | 耗时 ms | 首块 ms | 事件 / 心跳 / done | 相对滞后 p50/p95/max ms | 到达间隔 min/max ms | 源站调用 | 细节 | 符合 |
|---|---|---|---|---|---|---|---|---|---|---|
| H01 | GET 经 OAC(always)：查询串原样、自定义头转发、viewer Authorization 被替换 | 200 | 1096 |  |  |  |  | 1 | {"rawQueryString":"cursor=a%2Bb%3D%3D&path=dir%2Fsub%2Ffile.txt&empty=&x=1&rid=H01-25c476","authorization":null,"xDshToken":"viewer-token-abc","xRequestId":"req-123","viaHeaders":["cloudfront-forwarded-proto","cloudfront | ✓ |
| H02 | POST 带正确 x-amz-content-sha256（同时带 Bearer） | 200 | 611 |  |  |  |  | 1 | {"bodySha256":"ae0908d37dba87799da40d44189d1c52f2bdf67d62c7d574e59bc01452074b7a","bodyLength":29,"authorization":null} | ✓ |
| H03 | POST 不带 x-amz-content-sha256 | 403 | 408 |  |  |  |  | 0 | {"text":null,"amznError":"InvalidSignatureException","json":{"message":"The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the serv | ✓ |
| H04 | POST 带错误的 x-amz-content-sha256 | 403 | 410 |  |  |  |  | 0 | {"text":null,"amznError":"InvalidSignatureException"} | ✓ |
| H05 | POST 空请求体 + 空串 sha256 | 200 | 411 |  |  |  |  | 1 | "" | ✓ |
| H05b | POST 空请求体、不带 sha256（观察） | 200 | 305 |  |  |  |  | 1 | {"text":null} | ✓ |
| H06 | DELETE 无请求体、不带 sha256（观察） | 200 | 410 |  |  |  |  | 1 | {"text":null} | ✓ |
| H07 | OAC(no-override) + 缓存键含 Authorization，viewer 带 Bearer | 403 | 414 |  |  |  |  | 0 | {"text":null,"amznError":"AccessDeniedException","json":{"Message":"Forbidden"}} | ✓ |
| H08 | OAC(no-override)，viewer 不带 Authorization | 200 | 406 |  |  |  |  | 1 | {"authorization":null} | ✓ |
| H09 | 源未配置 OAC（AuthType=AWS_IAM 的 Function URL） | 403 | 407 |  |  |  |  | 0 | {"text":null} | ✓ |
| H10 | 直连 Function URL、未签名（绕过 CloudFront） | 403 | 614 |  |  |  |  | 0 | {"text":null} | ✓ |
| H11 | CachingDisabled：同一 GET 连发两次都回源 | 200/200 |  |  |  |  |  | 2 | {"xCache":["Miss from cloudfront","Miss from cloudfront"],"requestIds":["513f4902-1d2f-479c-91f9-3d5e23d10964","838818e2-c3f7-4fba-b6eb-53b14ec0b0e4"]} | ✓ |
| S01 | 20 个事件 / 250 ms 间隔（CloudFront） | 200 | 5150 | 409 | 20 / 0 / true | -10/30/30 | 206/291 | 1 | "" | ✓ |
| S01d | 20 个事件 / 250 ms 间隔（直连 Function URL 基线） | 200 | 5689 | 951 | 20 / 0 / true | -14/32/32 | 205/306 | 1 | "" | ✓ |
| S02 | 200 个小事件 / 20 ms 间隔（CloudFront） | 200 | 4784 | 595 | 200 / 0 / true | 10/57/260 | 0/272 | 1 | "" | ✓ |
| S02d | 200 个小事件 / 20 ms 间隔（直连基线） | 200 | 4708 | 634 | 200 / 0 / true | 0/112/253 | 0/234 | 1 | "" | ✓ |
| S02p | 50 个 4 KB 事件 / 50 ms 间隔（CloudFront） | 200 | 3068 | 615 | 50 / 0 / true | -21/170/271 | 0/308 | 1 | "" | ✓ |
| S03 | POST 首字节 25 s（Response timeout 30） | 200 | 26108 | 25904 | 3 / 0 / true | 1/1/1 | 102/102 | 1 | "" | ✓ |
| S04 | POST 首字节 35 s（Response timeout 30） | 504 | 30539 |  | 0 / 0 / false |  |  | 1 | "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\" \"http://www.w3.org/TR/html4/loose.dtd\">\n<HTML><HEAD><META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>ERROR: The" | ✓ |
| S05 | POST 先发头与 ": accepted"，随后静默 35 s（Response timeout 30） | 200 | 30940 | 932 | 0 / 1 / false |  |  | 1 | "TypeError: UND_ERR_SOCKET" | ✓ |
| S05m | POST 3 个事件后静默 35 s 再发 3 个（Response timeout 30） | 200 | 31126 | 924 | 3 / 0 / false | 0/0/0 | 100/103 | 1 | "TypeError: UND_ERR_SOCKET" | ✓ |
| S07 | POST 首字节 45 s（Response timeout 60） | 200 | 46093 | 45896 | 3 / 0 / true | -4/0/0 | 98/99 | 1 | "" | ✓ |
| S08 | POST 先发头，静默 65 s（Response timeout 60） | 200 | 60821 | 812 | 0 / 1 / false |  |  | 1 | "TypeError: UND_ERR_SOCKET" | ✓ |
| S06 | POST 先发头，静默 70 s 期间每 10 s 心跳（Response timeout 30） | 200 | 71164 | 922 | 3 / 7 / true | 2/4/4 | 102/103 | 1 | "" | ✓ |
| S04g | GET 首字节 35 s（Response timeout 30，观察是否重试源站） | 504 | 90774 |  | 0 / 0 / false |  |  | 3 | "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\" \"http://www.w3.org/TR/html4/loose.dtd\">\n<HTML><HEAD><META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>ERROR: The" | ✓ |
| S09 | POST 持续 180 s：每 10 s 心跳，其间零星事件（Response timeout 30） | 200 | 181146 | 937 | 4 / 18 / true | -3/0/0 | 80/180027 | 1 | "" | ✓ |
| R01 | POST 首字节超时后 CloudFront 不重试源站（S04 源站调用次数 = 1） |  |  |  |  |  |  |  | 1 | ✓ |
| R03-S04 | S04 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察） |  |  |  |  |  |  |  | {"elapsedMs":35264,"closedAt":null,"errorAt":null,"error":null,"writes":4,"writesAfterClose":0,"writeErrors":0} | ✓ |
| R03-S05 | S05 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察） |  |  |  |  |  |  |  | {"elapsedMs":35245,"closedAt":null,"errorAt":null,"error":null,"writes":5,"writesAfterClose":0,"writeErrors":0} | ✓ |
| R03-S05m | S05m 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察） |  |  |  |  |  |  |  | {"elapsedMs":35497,"closedAt":null,"errorAt":null,"error":null,"writes":7,"writesAfterClose":0,"writeErrors":0} | ✓ |
| R03-S08 | S08 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察） |  |  |  |  |  |  |  | {"elapsedMs":65248,"closedAt":null,"errorAt":null,"error":null,"writes":5,"writesAfterClose":0,"writeErrors":0} | ✓ |
| R03-S06 | S06 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察） |  |  |  |  |  |  |  | {"elapsedMs":70249,"closedAt":null,"errorAt":null,"error":null,"writes":11,"writesAfterClose":0,"writeErrors":0} | ✓ |
| R02 | GET 首字节超时后 CloudFront 按 ConnectionAttempts 重试源站（S04g 源站调用次数，观察） |  |  |  |  |  |  |  | 3 | ✓ |

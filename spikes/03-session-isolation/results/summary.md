# Spike 03 结果摘要

- 区域：us-east-1；运行时间：2026-09-26T09:06:33.222Z
- 用例总数 127，不符合预期 0
- 工作空间凭证铸造（本机 → STS AssumeRole，10 次）：P50 308 ms，最大 616 ms
- 探针 A：InvokeAgentRuntime 4488 ms；执行角色身份 `arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590`；子进程身份 `arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590`
- 探针 B：InvokeAgentRuntime 3147 ms；执行角色身份 `arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099`；子进程身份 `arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099`

| 位置 | 组 | 身份 | 用例 | 说明 | 预期 | 实际 | 错误 / 细节 | 符合 |
|---|---|---|---|---|---|---|---|---|
| local | tag |  | T01 | sessionId 标签值为 '*' | reject | error | ValidationError: 1 validation error detected: Value '*' at 'tags.1.member.value' failed to satisfy constraint: Member must satisfy regular expression pattern: [ | ✓ |
| local | tag |  | T02 | 不带任何会话标签 | reject | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-gateway-sim-role/spike03-gateway-sim is not authorized to perform: sts:AssumeRole on | ✓ |
| local | tag |  | T03 | sessionId 非 UUID 形态（'87cfaa9c-dc60-4296-8895-8ee24b7b3d11/../x'） | reject | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-gateway-sim-role/spike03-gateway-sim is not authorized to perform: sts:TagSession on | ✓ |
| local | tag |  | T04 | 额外标签键 userId | reject | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-gateway-sim-role/spike03-gateway-sim is not authorized to perform: sts:TagSession on | ✓ |
| local | tag |  | T05 | DurationSeconds=3600（角色链上限） | allow | allowed |  | ✓ |
| local | tag |  | T06 | DurationSeconds=3601（超过角色链上限） | reject | error | ValidationError: The requested DurationSeconds exceeds the MaxSessionDuration set for this role. | ✓ |
| local | tag |  | T07 | UUID 形态但非十六进制（'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'，说明模式只校验形态） | allow | allowed |  | ✓ |
| local | tag |  | T08 | 标签键大小写变体 SessionId（aws:TagKeys 大小写敏感比较） | reject | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-gateway-sim-role/spike03-gateway-sim is not authorized to perform: sts:TagSession on | ✓ |
| local | scoped | A | M01 | s3 GetObject 本会话 seed | allow | allowed |  | ✓ |
| local | scoped | A | M02 | s3 PutObject 本会话 | allow | allowed |  | ✓ |
| local | scoped | A | M03 | s3 ListObjectsV2 prefix=本会话/ | allow | allowed |  | ✓ |
| local | scoped | A | M04 | s3 DeleteObject 本会话（M02 写入的对象） | allow | allowed |  | ✓ |
| local | scoped | A | M05 | s3 GetObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M06 | s3 PutObject 对端 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M07 | s3 ListObjectsV2 prefix=对端/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M08 | s3 ListObjectsV2 prefix=workspaces/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M09 | s3 ListObjectsV2 无 prefix | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M10 | s3 DeleteObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M11 | s3 CopyObject 对端 seed → 本会话 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | A | M12 | s3 GetObject 本会话/../对端/seed.txt（点段穿越） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| local | scoped | A | M13 | s3 PutObject 本会话/../对端/traversal.txt（本机事后核对对端前缀无此对象） | noleak | allowed | "allowed, content not peer's (\"put-accepted\")" | ✓ |
| local | scoped | A | M14 | s3 GetObject 本会话/%2e%2e/对端/seed.txt（编码变形） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| local | scoped | A | M15 | ddb GetItem WORKSPACE#本会话/HEAD | allow | allowed |  | ✓ |
| local | scoped | A | M16 | ddb UpdateItem WORKSPACE#本会话/HEAD（条件更新） | allow | allowed |  | ✓ |
| local | scoped | A | M17 | ddb GetItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M18 | ddb UpdateItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M19 | ddb PutItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M20 | ddb GetItem SESSION#本会话/RUNCTL | allow | allowed |  | ✓ |
| local | scoped | A | M21 | ddb GetItem SESSION#对端/RUNCTL | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M22 | ddb PutItem SESSION#本会话/RUNCTL（适配层只读） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M23 | ddb Query PK=WORKSPACE#对端 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M24 | ddb Scan 全表 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| local | scoped | A | M25 | sts 用本会话凭证再 AssumeRole 工作空间角色并打对端标签 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| local | scoped | B | M01 | s3 GetObject 本会话 seed | allow | allowed |  | ✓ |
| local | scoped | B | M02 | s3 PutObject 本会话 | allow | allowed |  | ✓ |
| local | scoped | B | M03 | s3 ListObjectsV2 prefix=本会话/ | allow | allowed |  | ✓ |
| local | scoped | B | M04 | s3 DeleteObject 本会话（M02 写入的对象） | allow | allowed |  | ✓ |
| local | scoped | B | M05 | s3 GetObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M06 | s3 PutObject 对端 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M07 | s3 ListObjectsV2 prefix=对端/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M08 | s3 ListObjectsV2 prefix=workspaces/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M09 | s3 ListObjectsV2 无 prefix | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M10 | s3 DeleteObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M11 | s3 CopyObject 对端 seed → 本会话 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| local | scoped | B | M12 | s3 GetObject 本会话/../对端/seed.txt（点段穿越） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| local | scoped | B | M13 | s3 PutObject 本会话/../对端/traversal.txt（本机事后核对对端前缀无此对象） | noleak | allowed | "allowed, content not peer's (\"put-accepted\")" | ✓ |
| local | scoped | B | M14 | s3 GetObject 本会话/%2e%2e/对端/seed.txt（编码变形） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| local | scoped | B | M15 | ddb GetItem WORKSPACE#本会话/HEAD | allow | allowed |  | ✓ |
| local | scoped | B | M16 | ddb UpdateItem WORKSPACE#本会话/HEAD（条件更新） | allow | allowed |  | ✓ |
| local | scoped | B | M17 | ddb GetItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M18 | ddb UpdateItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M19 | ddb PutItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M20 | ddb GetItem SESSION#本会话/RUNCTL | allow | allowed |  | ✓ |
| local | scoped | B | M21 | ddb GetItem SESSION#对端/RUNCTL | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M22 | ddb PutItem SESSION#本会话/RUNCTL（适配层只读） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M23 | ddb Query PK=WORKSPACE#对端 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M24 | ddb Scan 全表 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| local | scoped | B | M25 | sts 用本会话凭证再 AssumeRole 工作空间角色并打对端标签 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | exec | A | E01 | sts GetCallerIdentity（执行角色） | allow | allowed |  | ✓ |
| microvm | exec | A | E02 | s3 GetObject 本会话 seed（执行角色 + PrincipalTag 条件） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590 is not authorized to | ✓ |
| microvm | exec | A | E03 | s3 ListObjectsV2 prefix=本会话/（执行角色） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590 is not authorized to | ✓ |
| microvm | exec | A | E04 | ddb GetItem WORKSPACE#本会话/HEAD（执行角色） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590 is not auth | ✓ |
| microvm | exec | A | E05 | sts AssumeRole 工作空间角色（执行角色） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590 is not authorized to | ✓ |
| microvm | scoped | A | M01 | s3 GetObject 本会话 seed | allow | allowed |  | ✓ |
| microvm | scoped | A | M02 | s3 PutObject 本会话 | allow | allowed |  | ✓ |
| microvm | scoped | A | M03 | s3 ListObjectsV2 prefix=本会话/ | allow | allowed |  | ✓ |
| microvm | scoped | A | M04 | s3 DeleteObject 本会话（M02 写入的对象） | allow | allowed |  | ✓ |
| microvm | scoped | A | M05 | s3 GetObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M06 | s3 PutObject 对端 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M07 | s3 ListObjectsV2 prefix=对端/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M08 | s3 ListObjectsV2 prefix=workspaces/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M09 | s3 ListObjectsV2 无 prefix | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M10 | s3 DeleteObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M11 | s3 CopyObject 对端 seed → 本会话 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | scoped | A | M12 | s3 GetObject 本会话/../对端/seed.txt（点段穿越） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| microvm | scoped | A | M13 | s3 PutObject 本会话/../对端/traversal.txt（本机事后核对对端前缀无此对象） | noleak | allowed | "allowed, content not peer's (\"put-accepted\")" | ✓ |
| microvm | scoped | A | M14 | s3 GetObject 本会话/%2e%2e/对端/seed.txt（编码变形） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| microvm | scoped | A | M15 | ddb GetItem WORKSPACE#本会话/HEAD | allow | allowed |  | ✓ |
| microvm | scoped | A | M16 | ddb UpdateItem WORKSPACE#本会话/HEAD（条件更新） | allow | allowed |  | ✓ |
| microvm | scoped | A | M17 | ddb GetItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M18 | ddb UpdateItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M19 | ddb PutItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M20 | ddb GetItem SESSION#本会话/RUNCTL | allow | allowed |  | ✓ |
| microvm | scoped | A | M21 | ddb GetItem SESSION#对端/RUNCTL | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M22 | ddb PutItem SESSION#本会话/RUNCTL（适配层只读） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M23 | ddb Query PK=WORKSPACE#对端 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M24 | ddb Scan 全表 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to | ✓ |
| microvm | scoped | A | M25 | sts 用本会话凭证再 AssumeRole 工作空间角色并打对端标签 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb is not authorized to perform: | ✓ |
| microvm | exec | A | E06 | 子进程（模拟 DSH 工具）经默认凭证链拿到的身份与执行角色相同 | observe | allowed | {"code":0,"ok":true,"Arn":"arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-d5a4b74e-c6f4-4bbf-abca-9f1e973a5590"} | ✓ |
| microvm | exec | A | E07 | 容器收到的 runtimeSessionId 请求头与调用方传入值一致 | observe | observed | "dsh-1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb-52a52aa8f8882a1a" | ✓ |
| microvm | exec | B | E01 | sts GetCallerIdentity（执行角色） | allow | allowed |  | ✓ |
| microvm | exec | B | E02 | s3 GetObject 本会话 seed（执行角色 + PrincipalTag 条件） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099 is not authorized to | ✓ |
| microvm | exec | B | E03 | s3 ListObjectsV2 prefix=本会话/（执行角色） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099 is not authorized to | ✓ |
| microvm | exec | B | E04 | ddb GetItem WORKSPACE#本会话/HEAD（执行角色） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099 is not auth | ✓ |
| microvm | exec | B | E05 | sts AssumeRole 工作空间角色（执行角色） | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099 is not authorized to | ✓ |
| microvm | scoped | B | M01 | s3 GetObject 本会话 seed | allow | allowed |  | ✓ |
| microvm | scoped | B | M02 | s3 PutObject 本会话 | allow | allowed |  | ✓ |
| microvm | scoped | B | M03 | s3 ListObjectsV2 prefix=本会话/ | allow | allowed |  | ✓ |
| microvm | scoped | B | M04 | s3 DeleteObject 本会话（M02 写入的对象） | allow | allowed |  | ✓ |
| microvm | scoped | B | M05 | s3 GetObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M06 | s3 PutObject 对端 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M07 | s3 ListObjectsV2 prefix=对端/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M08 | s3 ListObjectsV2 prefix=workspaces/ | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M09 | s3 ListObjectsV2 无 prefix | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M10 | s3 DeleteObject 对端 seed | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M11 | s3 CopyObject 对端 seed → 本会话 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | scoped | B | M12 | s3 GetObject 本会话/../对端/seed.txt（点段穿越） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| microvm | scoped | B | M13 | s3 PutObject 本会话/../对端/traversal.txt（本机事后核对对端前缀无此对象） | noleak | allowed | "allowed, content not peer's (\"put-accepted\")" | ✓ |
| microvm | scoped | B | M14 | s3 GetObject 本会话/%2e%2e/对端/seed.txt（编码变形） | noleak | error | NoSuchKey: The specified key does not exist. | ✓ |
| microvm | scoped | B | M15 | ddb GetItem WORKSPACE#本会话/HEAD | allow | allowed |  | ✓ |
| microvm | scoped | B | M16 | ddb UpdateItem WORKSPACE#本会话/HEAD（条件更新） | allow | allowed |  | ✓ |
| microvm | scoped | B | M17 | ddb GetItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M18 | ddb UpdateItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M19 | ddb PutItem WORKSPACE#对端/HEAD | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M20 | ddb GetItem SESSION#本会话/RUNCTL | allow | allowed |  | ✓ |
| microvm | scoped | B | M21 | ddb GetItem SESSION#对端/RUNCTL | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M22 | ddb PutItem SESSION#本会话/RUNCTL（适配层只读） | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M23 | ddb Query PK=WORKSPACE#对端 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M24 | ddb Scan 全表 | deny | denied | AccessDeniedException: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to | ✓ |
| microvm | scoped | B | M25 | sts 用本会话凭证再 AssumeRole 工作空间角色并打对端标签 | deny | denied | AccessDenied: User: arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-workspace-role/ws-87cfaa9c-dc60-4296-8895-8ee24b7b3d11 is not authorized to perform: | ✓ |
| microvm | exec | B | E06 | 子进程（模拟 DSH 工具）经默认凭证链拿到的身份与执行角色相同 | observe | allowed | {"code":0,"ok":true,"Arn":"arn:aws:sts::271547278201:assumed-role/dsh-poc-spike-03-exec-role/BedrockAgentCore-c71ebe10-3bbd-4849-b0c5-cfa4ceaf2099"} | ✓ |
| microvm | exec | B | E07 | 容器收到的 runtimeSessionId 请求头与调用方传入值一致 | observe | observed | "dsh-87cfaa9c-dc60-4296-8895-8ee24b7b3d11-6f073cc76f1f8421" | ✓ |
| local | post | A | P01 | 管理员列举本会话前缀：除 seed.txt 与字面量 ../ 键外，没有对端写入的对象 | observe | observed | ["../87cfaa9c-dc60-4296-8895-8ee24b7b3d11/traversal-localA.txt","../87cfaa9c-dc60-4296-8895-8ee24b7b3d11/traversal-probe.txt","seed.txt"] | ✓ |
| local | post | A | P02 | HEAD.version 只被本会话的 M16 递增（初始 1，本机与 microVM 各一次 → 3），未被对端改为 999 | observe | observed | 3 | ✓ |
| local | post | B | P01 | 管理员列举本会话前缀：除 seed.txt 与字面量 ../ 键外，没有对端写入的对象 | observe | observed | ["../1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb/traversal-localB.txt","../1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb/traversal-probe.txt","seed.txt"] | ✓ |
| local | post | B | P02 | HEAD.version 只被本会话的 M16 递增（初始 1，本机与 microVM 各一次 → 3），未被对端改为 999 | observe | observed | 3 | ✓ |
| local | post |  | P03 | 点段穿越写入（M13）在 S3 中以字面量键保存的位置 | observe | observed | ["workspaces/1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb/../87cfaa9c-dc60-4296-8895-8ee24b7b3d11/traversal-localA.txt","workspaces/1e77fcd4-7f59-4cba-83a9-2db4f0c4cedb | ✓ |

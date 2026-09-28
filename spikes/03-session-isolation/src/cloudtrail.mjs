// 从 CloudTrail 事件历史拉取 AssumeRole 事件，确认 AgentCore 以什么参数扮演执行角色：
// 是否携带会话标签（tags / transitiveTagKeys）、sourceIdentity、roleSessionName。
// 工作空间角色的 AssumeRole（由 gateway-sim 带 sessionId 标签发起）作为阳性对照：
// 证明 CloudTrail 在有标签时确实记录 tags 字段。
//
// CloudTrail 事件历史通常有 5–15 分钟延迟；脚本轮询至两类事件都出现或超时（默认 20 分钟）。
// 输出 results/cloudtrail-assumerole.jsonl（不含任何凭证字段）。

import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { loadState, writeJsonl, sleep } from './lib.mjs';

const st = loadState();
const ct = new CloudTrailClient({ region: st.REGION });
const start = new Date(Number(st.SETUP_STARTED_MS) - 60_000);
const deadline = Date.now() + Number(process.env.CLOUDTRAIL_WAIT_MINUTES ?? 20) * 60_000;

async function lookup(roleArn) {
  const out = [];
  let NextToken;
  do {
    const r = await ct.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: roleArn }],
      StartTime: start,
      NextToken,
    }));
    for (const e of r.Events ?? []) {
      if (e.EventName !== 'AssumeRole') continue;
      const ev = JSON.parse(e.CloudTrailEvent);
      const rp = ev.requestParameters ?? {};
      out.push({
        role: roleArn === st.EXEC_ROLE_ARN ? 'exec' : 'workspace',
        eventTime: ev.eventTime,
        eventId: ev.eventID,
        userIdentityType: ev.userIdentity?.type,
        invokedBy: ev.userIdentity?.invokedBy ?? null,
        callerArn: ev.userIdentity?.arn ?? null,
        sourceIPAddress: ev.sourceIPAddress,
        userAgent: ev.userAgent,
        roleSessionName: rp.roleSessionName,
        durationSeconds: rp.durationSeconds ?? null,
        tags: rp.tags ?? null,
        transitiveTagKeys: rp.transitiveTagKeys ?? null,
        sourceIdentity: rp.sourceIdentity ?? null,
        policyPresent: rp.policy !== undefined,
        policyArns: rp.policyArns ?? null,
        requestParameterKeys: Object.keys(rp).sort(),
        additionalEventData: ev.additionalEventData ?? null,
        assumedRoleArn: ev.responseElements?.assumedRoleUser?.arn ?? null,
        errorCode: ev.errorCode ?? null,
      });
    }
    NextToken = r.NextToken;
    await sleep(600); // LookupEvents 限速 2 次/秒
  } while (NextToken);
  return out;
}

let execEvents = [];
let wsEvents = [];
for (;;) {
  execEvents = await lookup(st.EXEC_ROLE_ARN);
  wsEvents = await lookup(st.WS_ROLE_ARN);
  const wsTagged = wsEvents.some((e) => e.tags);
  console.log(`${new Date().toISOString()} exec AssumeRole=${execEvents.length} workspace AssumeRole=${wsEvents.length} (tagged=${wsTagged})`);
  if ((execEvents.length && wsTagged) || Date.now() > deadline) break;
  await sleep(60_000);
}

writeJsonl('cloudtrail-assumerole.jsonl', [...execEvents, ...wsEvents]);
const execTagged = execEvents.filter((e) => e.tags || e.transitiveTagKeys);
console.log(`exec role AssumeRole events: ${execEvents.length}, with tags: ${execTagged.length}`);
console.log(`exec roleSessionNames: ${[...new Set(execEvents.map((e) => e.roleSessionName))].join(', ')}`);
console.log(`exec requestParameter keys: ${[...new Set(execEvents.flatMap((e) => e.requestParameterKeys))].join(', ')}`);
if (!execEvents.length) {
  console.log('未在时限内看到执行角色的 AssumeRole 事件，可稍后用 CLOUDTRAIL_WAIT_MINUTES=... 重跑本脚本（资源删除后仍可查询）。');
  process.exitCode = 2;
}

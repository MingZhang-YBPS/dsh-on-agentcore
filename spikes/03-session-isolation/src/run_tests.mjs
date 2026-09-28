// Spike 03 主测试：本机（模拟接入服务）铸造会话限定凭证 → 本机矩阵 → AgentCore microVM 内矩阵 → 事后核对。
// 结果：results/cases.jsonl、results/runtime-probe-{A,B}.json、results/summary.md
//
// 运行本脚本的 IAM 身份扮演两个角色：
//   1. 管理员：播种与事后核对（直接用默认凭证）
//   2. 接入服务：先 AssumeRole gateway-sim 角色，再由它带 sessionId 标签 AssumeRole 工作空间角色（与 Lambda 角色链相同）

import { randomBytes } from 'node:crypto';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { makeClients, scopedMatrix } from './matrix.mjs';
import { loadState, writeJson, writeJsonl, sleep, percentile, resultsPath } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const st = loadState();
const region = st.REGION;
const A = st.SESSION_A;
const B = st.SESSION_B;
const ctxBase = { bucket: st.BUCKET, table: st.TABLE_NAME, workspaceRoleArn: st.WS_ROLE_ARN };
const rows = [];
const log = (...a) => console.log(...a);

const toCreds = (c) => ({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken });

async function retry(label, fn, { tries = 12, delayMs = 5000, retryOn = () => true } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !retryOn(e)) throw e;
      log(`  ${label}: ${e.name} (${i}/${tries})，${delayMs} ms 后重试`);
      await sleep(delayMs);
    }
  }
}

// ---- 1. 接入服务身份 ----
const adminSts = new STSClient({ region });
const gw = await retry('assume gateway-sim', () =>
  adminSts.send(new AssumeRoleCommand({ RoleArn: st.GW_ROLE_ARN, RoleSessionName: 'spike03-gateway-sim', DurationSeconds: 3600 })),
  { retryOn: (e) => e.name === 'AccessDenied' });
const gwSts = new STSClient({ region, credentials: toCreds(gw.Credentials), maxAttempts: 1 });

async function mint(sessionId, extra = {}) {
  const t0 = performance.now();
  const r = await gwSts.send(new AssumeRoleCommand({
    RoleArn: st.WS_ROLE_ARN,
    RoleSessionName: `ws-${String(sessionId).replace(/[^\w+=,.@-]/g, '_').slice(0, 40)}`,
    DurationSeconds: 3600,
    Tags: [{ Key: 'sessionId', Value: sessionId }],
    ...extra,
  }));
  return { creds: toCreds(r.Credentials), ms: performance.now() - t0, assumedRoleArn: r.AssumedRoleUser.Arn, packedPolicySize: r.PackedPolicySize };
}

// 首次铸造可能遇到 IAM 传播延迟
const mintedA = await retry('mint A', () => mint(A), { retryOn: (e) => e.name === 'AccessDenied' });
const mintedB = await mint(B);
log(`minted A: ${mintedA.assumedRoleArn} packedPolicySize=${mintedA.packedPolicySize}%`);

// ---- 2. 铸造延迟（本机 WSL → STS，仅作参考） ----
const lat = [];
for (let i = 0; i < 10; i++) lat.push((await mint(A)).ms);
const mintLatency = { samples: lat.map((x) => Math.round(x)), p50: Math.round(percentile(lat, 50)), max: Math.round(Math.max(...lat)) };
log(`mint latency ms: p50=${mintLatency.p50} max=${mintLatency.max}`);

// ---- 3. 标签与参数边界（信任策略条件） ----
const tagCase = async (id, desc, expect, fn) => {
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const outcome = !err ? 'allowed' : (err.name === 'AccessDenied' ? 'denied' : 'error');
  const pass = expect === 'allow' ? outcome === 'allowed' : outcome !== 'allowed';
  rows.push({ location: 'local', group: 'tag', id, desc, expect, outcome, error: err ? `${err.name}: ${String(err.message).slice(0, 200)}` : null, ms: Date.now() - t0, pass });
};
const fakeUuidShape = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
await tagCase('T01', "sessionId 标签值为 '*'", 'reject', () => mint('*'));
await tagCase('T02', '不带任何会话标签', 'reject', () =>
  gwSts.send(new AssumeRoleCommand({ RoleArn: st.WS_ROLE_ARN, RoleSessionName: 'no-tag' })));
await tagCase('T03', `sessionId 非 UUID 形态（'${B}/../x'）`, 'reject', () => mint(`${B}/../x`));
await tagCase('T04', '额外标签键 userId', 'reject', () =>
  mint(A, { Tags: [{ Key: 'sessionId', Value: A }, { Key: 'userId', Value: 'u1' }] }));
await tagCase('T05', 'DurationSeconds=3600（角色链上限）', 'allow', () => mint(A, { DurationSeconds: 3600 }));
await tagCase('T06', 'DurationSeconds=3601（超过角色链上限）', 'reject', () => mint(A, { DurationSeconds: 3601 }));
await tagCase('T07', `UUID 形态但非十六进制（'${fakeUuidShape}'，说明模式只校验形态）`, 'allow', () => mint(fakeUuidShape));
await tagCase('T08', '标签键大小写变体 SessionId（aws:TagKeys 大小写敏感比较）', 'reject', () =>
  mint(A, { Tags: [{ Key: 'SessionId', Value: A }] }));

// ---- 4. 本机矩阵（接入服务所在位置） ----
for (const [own, peer, minted, label] of [[A, B, mintedA, 'A'], [B, A, mintedB, 'B']]) {
  const cases = await scopedMatrix(makeClients(region, minted.creds), { ...ctxBase, own, peer, tag: `local${label}` });
  for (const c of cases) rows.push({ location: 'local', group: 'scoped', as: label, ...c });
}

// ---- 5. AgentCore microVM 内矩阵 ----
const ac = new BedrockAgentCoreClient({ region });
const probes = {};
for (const [own, peer, minted, label] of [[A, B, mintedA, 'A'], [B, A, mintedB, 'B']]) {
  const runtimeSessionId = `dsh-${own}-${randomBytes(8).toString('hex')}`;
  const payload = {
    sessionId: own,
    peerSessionId: peer,
    bucket: st.BUCKET,
    table: st.TABLE_NAME,
    region,
    workspaceRoleArn: st.WS_ROLE_ARN,
    scopedCredentials: minted.creds,
  };
  const t0 = Date.now();
  const resp = await retry(`invoke ${label}`, () => ac.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: st.RUNTIME_ARN,
    runtimeSessionId,
    qualifier: 'DEFAULT',
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(JSON.stringify(payload)),
  })), { tries: 6, delayMs: 5000, retryOn: (e) => /Conflict|Throttl|ServiceUnavailable|RuntimeClientError|InternalServer/i.test(e.name) });
  const text = await resp.response.transformToString();
  const invokeMs = Date.now() - t0;
  let probe;
  try { probe = JSON.parse(text); } catch { probe = { raw: text.slice(0, 2000) }; }
  probe.invokeMs = invokeMs;
  probe.runtimeSessionId = runtimeSessionId;
  probe.statusCode = resp.statusCode;
  probes[label] = probe;
  writeJson(`runtime-probe-${label}.json`, probe);
  log(`probe ${label}: invoke ${invokeMs} ms, exec identity ${probe.execRole?.identity?.Arn}`);
  for (const c of probe.execRole?.cases ?? []) rows.push({ location: 'microvm', group: 'exec', as: label, ...c });
  for (const c of probe.scopedCases ?? []) rows.push({ location: 'microvm', group: 'scoped', as: label, ...c });
  rows.push({
    location: 'microvm', group: 'exec', as: label, id: 'E06',
    desc: '子进程（模拟 DSH 工具）经默认凭证链拿到的身份与执行角色相同',
    expect: 'observe', outcome: probe.childIdentity?.ok ? 'allowed' : 'error',
    detail: probe.childIdentity, pass: probe.childIdentity?.Arn === probe.execRole?.identity?.Arn,
  });
  rows.push({
    location: 'microvm', group: 'exec', as: label, id: 'E07',
    desc: '容器收到的 runtimeSessionId 请求头与调用方传入值一致',
    expect: 'observe', outcome: 'observed', detail: probe.runtimeSessionIdHeader,
    pass: probe.runtimeSessionIdHeader === runtimeSessionId,
  });
  await ac.send(new StopRuntimeSessionCommand({ agentRuntimeArn: st.RUNTIME_ARN, runtimeSessionId, qualifier: 'DEFAULT' }))
    .catch((e) => log(`  stop session ${label}: ${e.name}`));
}

// ---- 6. 事后核对（管理员凭证） ----
const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });
for (const [sid, label] of [[A, 'A'], [B, 'B']]) {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: st.BUCKET, Prefix: `workspaces/${sid}/` }));
  const keys = (listed.Contents ?? []).map((o) => o.Key.slice(`workspaces/${sid}/`.length));
  const foreign = keys.filter((k) => k !== 'seed.txt' && !k.startsWith('../'));
  rows.push({
    location: 'local', group: 'post', as: label, id: 'P01',
    desc: '管理员列举本会话前缀：除 seed.txt 与字面量 ../ 键外，没有对端写入的对象',
    expect: 'observe', outcome: 'observed', detail: keys, pass: foreign.length === 0,
  });
  const head = await ddb.send(new GetItemCommand({ TableName: st.TABLE_NAME, Key: { PK: { S: `WORKSPACE#${sid}` }, SK: { S: 'HEAD' } }, ConsistentRead: true }));
  const v = Number(head.Item?.version?.N);
  rows.push({
    location: 'local', group: 'post', as: label, id: 'P02',
    desc: 'HEAD.version 只被本会话的 M16 递增（初始 1，本机与 microVM 各一次 → 3），未被对端改为 999',
    expect: 'observe', outcome: 'observed', detail: v, pass: v === 3,
  });
}
// M13 的字面量键落在哪里
const traversal = await s3.send(new ListObjectsV2Command({ Bucket: st.BUCKET, Prefix: 'workspaces/' }));
const traversalKeys = (traversal.Contents ?? []).map((o) => o.Key).filter((k) => k.includes('..') || k.includes('%2e'));
rows.push({
  location: 'local', group: 'post', id: 'P03',
  desc: '点段穿越写入（M13）在 S3 中以字面量键保存的位置',
  expect: 'observe', outcome: 'observed', detail: traversalKeys,
  pass: traversalKeys.every((k) => k.startsWith(`workspaces/${A}/../`) || k.startsWith(`workspaces/${B}/../`)),
});

// ---- 7. 输出 ----
writeJsonl('cases.jsonl', rows);
writeJson('mint-latency.json', mintLatency);

const failed = rows.filter((r) => !r.pass);
const md = [];
md.push('# Spike 03 结果摘要', '');
md.push(`- 区域：${region}；运行时间：${new Date().toISOString()}`);
md.push(`- 用例总数 ${rows.length}，不符合预期 ${failed.length}`);
md.push(`- 工作空间凭证铸造（本机 → STS AssumeRole，10 次）：P50 ${mintLatency.p50} ms，最大 ${mintLatency.max} ms`);
for (const l of ['A', 'B']) {
  const p = probes[l];
  md.push(`- 探针 ${l}：InvokeAgentRuntime ${p?.invokeMs} ms；执行角色身份 \`${p?.execRole?.identity?.Arn}\`；子进程身份 \`${p?.childIdentity?.Arn ?? p?.childIdentity?.error}\``);
}
md.push('', '| 位置 | 组 | 身份 | 用例 | 说明 | 预期 | 实际 | 错误 / 细节 | 符合 |', '|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const det = r.error ?? (r.detail !== undefined ? JSON.stringify(r.detail) : '');
  md.push(`| ${r.location} | ${r.group} | ${r.as ?? ''} | ${r.id} | ${r.desc} | ${r.expect} | ${r.outcome} | ${String(det).replace(/\|/g, '\\|').slice(0, 160)} | ${r.pass ? '✓' : '✗'} |`);
}
writeFileSync(resultsPath('summary.md'), md.join('\n') + '\n');
log(`\n${rows.length} cases, ${failed.length} not as expected`);
for (const f of failed) log(`  ✗ ${f.location} ${f.group} ${f.as ?? ''} ${f.id} ${f.desc}: ${f.outcome} ${f.error ?? JSON.stringify(f.detail ?? '')}`);
process.exitCode = failed.length ? 1 : 0;

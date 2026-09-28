// 用例矩阵：同一套用例既在本机（模拟接入服务所在位置）运行，也打包进 AgentCore 探针在 microVM 内运行。
// 每个用例返回 { id, desc, expect, outcome, error, httpStatus, ms, pass, detail }。
//   expect: allow  —— 必须成功
//           deny   —— 必须 AccessDenied（S3 403 AccessDenied / DynamoDB AccessDeniedException / STS AccessDenied）
//           noleak —— 允许成功或失败，但绝不能读到/影响对端会话的数据

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export const SEED_TEXT = (sessionId) => `seed-of-${sessionId}`;

export function makeClients(region, credentials) {
  const cfg = { region, maxAttempts: 1, ...(credentials ? { credentials } : {}) };
  return { s3: new S3Client(cfg), ddb: new DynamoDBClient(cfg), sts: new STSClient(cfg) };
}

const DENY_NAMES = new Set(['AccessDenied', 'AccessDeniedException']);

function classify(err) {
  if (!err) return 'allowed';
  if (DENY_NAMES.has(err.name) || DENY_NAMES.has(err.Code)) return 'denied';
  return 'error';
}

async function run(id, desc, expect, fn, judge) {
  const t0 = Date.now();
  let err = null;
  let value;
  try {
    value = await fn();
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  const outcome = classify(err);
  let pass;
  let detail;
  if (judge) {
    ({ pass, detail } = judge({ outcome, err, value }));
  } else if (expect === 'allow') {
    pass = outcome === 'allowed';
  } else {
    pass = outcome === 'denied';
  }
  return {
    id,
    desc,
    expect,
    outcome,
    error: err ? `${err.name}: ${String(err.message).slice(0, 200)}` : null,
    httpStatus: err?.$metadata?.httpStatusCode ?? value?.$metadata?.httpStatusCode ?? null,
    ms,
    pass,
    ...(detail !== undefined ? { detail } : {}),
  };
}

const body = async (r) => (r.Body ? await r.Body.transformToString() : '');

// 会话 A 的凭证（c）对 A、B 两个会话的工作空间与控制项做全部操作。
export async function scopedMatrix(c, { bucket, table, own, peer, workspaceRoleArn, tag = '' }) {
  const ownPrefix = `workspaces/${own}/`;
  const peerPrefix = `workspaces/${peer}/`;
  const probeKey = `${ownPrefix}probe-${tag}-${Date.now()}.txt`;
  const key = (pk, sk) => ({ PK: { S: pk }, SK: { S: sk } });
  const noLeak = ({ outcome, err, value }) => {
    if (outcome === 'allowed') {
      const leaked = value?.text === SEED_TEXT(peer);
      return { pass: !leaked, detail: leaked ? 'LEAKED peer content' : `allowed, content not peer's (${JSON.stringify(value?.text ?? '').slice(0, 60)})` };
    }
    return { pass: outcome === 'denied' || err?.name === 'NoSuchKey', detail: err?.name };
  };

  const cases = [];
  const push = async (...a) => cases.push(await run(...a));

  await push('M01', 's3 GetObject 本会话 seed', 'allow', async () => {
    const r = await c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${ownPrefix}seed.txt` }));
    const text = await body(r);
    if (text !== SEED_TEXT(own)) throw new Error(`unexpected content ${text}`);
    return r;
  });
  await push('M02', 's3 PutObject 本会话', 'allow', () =>
    c.s3.send(new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: 'probe' })));
  await push('M03', 's3 ListObjectsV2 prefix=本会话/', 'allow', () =>
    c.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: ownPrefix })));
  await push('M04', 's3 DeleteObject 本会话（M02 写入的对象）', 'allow', () =>
    c.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey })));

  await push('M05', 's3 GetObject 对端 seed', 'deny', () =>
    c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${peerPrefix}seed.txt` })));
  await push('M06', 's3 PutObject 对端', 'deny', () =>
    c.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${peerPrefix}intrusion-${tag}.txt`, Body: 'x' })));
  await push('M07', 's3 ListObjectsV2 prefix=对端/', 'deny', () =>
    c.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: peerPrefix })));
  await push('M08', 's3 ListObjectsV2 prefix=workspaces/', 'deny', () =>
    c.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'workspaces/' })));
  await push('M09', 's3 ListObjectsV2 无 prefix', 'deny', () =>
    c.s3.send(new ListObjectsV2Command({ Bucket: bucket })));
  await push('M10', 's3 DeleteObject 对端 seed', 'deny', () =>
    c.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${peerPrefix}seed.txt` })));
  await push('M11', 's3 CopyObject 对端 seed → 本会话', 'deny', () =>
    c.s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${peerPrefix}seed.txt`, Key: `${ownPrefix}copied-${tag}.txt` })));

  await push('M12', 's3 GetObject 本会话/../对端/seed.txt（点段穿越）', 'noleak', async () => {
    const r = await c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${ownPrefix}../${peer}/seed.txt` }));
    return { text: await body(r) };
  }, noLeak);
  await push('M13', 's3 PutObject 本会话/../对端/traversal.txt（本机事后核对对端前缀无此对象）', 'noleak', async () => {
    await c.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${ownPrefix}../${peer}/traversal-${tag}.txt`, Body: 'x' }));
    return { text: 'put-accepted' };
  }, noLeak);
  await push('M14', 's3 GetObject 本会话/%2e%2e/对端/seed.txt（编码变形）', 'noleak', async () => {
    const r = await c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${ownPrefix}%2e%2e/${peer}/seed.txt` }));
    return { text: await body(r) };
  }, noLeak);

  await push('M15', 'ddb GetItem WORKSPACE#本会话/HEAD', 'allow', () =>
    c.ddb.send(new GetItemCommand({ TableName: table, Key: key(`WORKSPACE#${own}`, 'HEAD'), ConsistentRead: true })));
  await push('M16', 'ddb UpdateItem WORKSPACE#本会话/HEAD（条件更新）', 'allow', () =>
    c.ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: key(`WORKSPACE#${own}`, 'HEAD'),
      UpdateExpression: 'SET #v = #v + :one',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':one': { N: '1' } },
    })));
  await push('M17', 'ddb GetItem WORKSPACE#对端/HEAD', 'deny', () =>
    c.ddb.send(new GetItemCommand({ TableName: table, Key: key(`WORKSPACE#${peer}`, 'HEAD'), ConsistentRead: true })));
  await push('M18', 'ddb UpdateItem WORKSPACE#对端/HEAD', 'deny', () =>
    c.ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: key(`WORKSPACE#${peer}`, 'HEAD'),
      UpdateExpression: 'SET #v = :n',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':n': { N: '999' } },
    })));
  await push('M19', 'ddb PutItem WORKSPACE#对端/HEAD', 'deny', () =>
    c.ddb.send(new PutItemCommand({ TableName: table, Item: { ...key(`WORKSPACE#${peer}`, 'HEAD'), version: { N: '999' } } })));
  await push('M20', 'ddb GetItem SESSION#本会话/RUNCTL', 'allow', () =>
    c.ddb.send(new GetItemCommand({ TableName: table, Key: key(`SESSION#${own}`, 'RUNCTL'), ConsistentRead: true })));
  await push('M21', 'ddb GetItem SESSION#对端/RUNCTL', 'deny', () =>
    c.ddb.send(new GetItemCommand({ TableName: table, Key: key(`SESSION#${peer}`, 'RUNCTL'), ConsistentRead: true })));
  await push('M22', 'ddb PutItem SESSION#本会话/RUNCTL（适配层只读）', 'deny', () =>
    c.ddb.send(new PutItemCommand({ TableName: table, Item: { ...key(`SESSION#${own}`, 'RUNCTL'), state: { S: 'idle' } } })));
  await push('M23', 'ddb Query PK=WORKSPACE#对端', 'deny', () =>
    c.ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': { S: `WORKSPACE#${peer}` } },
    })));
  await push('M24', 'ddb Scan 全表', 'deny', () =>
    c.ddb.send(new ScanCommand({ TableName: table, Limit: 5 })));
  await push('M25', 'sts 用本会话凭证再 AssumeRole 工作空间角色并打对端标签', 'deny', () =>
    c.sts.send(new AssumeRoleCommand({
      RoleArn: workspaceRoleArn,
      RoleSessionName: 'escalate',
      Tags: [{ Key: 'sessionId', Value: peer }],
    })));
  return cases;
}

// microVM 内默认凭证（执行角色）的用例：执行角色挂了 PrincipalTag 限定的工作空间权限，
// 若 AgentCore 注入了 sessionId 会话标签，E02–E04 会成功。
export async function execRoleCases(c, { bucket, table, own, workspaceRoleArn }) {
  const cases = [];
  const push = async (...a) => cases.push(await run(...a));
  let identity = null;
  await push('E01', 'sts GetCallerIdentity（执行角色）', 'allow', async () => {
    identity = await c.sts.send(new GetCallerIdentityCommand({}));
    return identity;
  });
  await push('E02', 's3 GetObject 本会话 seed（执行角色 + PrincipalTag 条件）', 'deny', () =>
    c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `workspaces/${own}/seed.txt` })));
  await push('E03', 's3 ListObjectsV2 prefix=本会话/（执行角色）', 'deny', () =>
    c.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `workspaces/${own}/` })));
  await push('E04', 'ddb GetItem WORKSPACE#本会话/HEAD（执行角色）', 'deny', () =>
    c.ddb.send(new GetItemCommand({ TableName: table, Key: { PK: { S: `WORKSPACE#${own}` }, SK: { S: 'HEAD' } } })));
  await push('E05', 'sts AssumeRole 工作空间角色（执行角色）', 'deny', () =>
    c.sts.send(new AssumeRoleCommand({
      RoleArn: workspaceRoleArn,
      RoleSessionName: 'from-exec-role',
      Tags: [{ Key: 'sessionId', Value: own }],
    })));
  return {
    identity: identity ? { Arn: identity.Arn, UserId: identity.UserId, Account: identity.Account } : null,
    cases,
  };
}

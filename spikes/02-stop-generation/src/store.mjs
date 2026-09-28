// DynamoDB 访问层：会话元数据、消息、运行控制（RUNCTL）。
// 键设计与 design.md「DynamoDB 单表设计」一致：PK=SESSION#{id}，SK=META | MSG#{seq:012d} | RUNCTL。
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export const TABLE = 'DshPocTable';
const pk = (sessionId) => `SESSION#${sessionId}`;
const msgSk = (seq) => `MSG#${String(seq).padStart(12, '0')}`;
/** 残留 running 项视为过期的阈值：接入服务 Lambda 最长执行 15 分钟 */
export const STALE_RUN_MS = 15 * 60 * 1000;

export function makeStore() {
  const client = new DynamoDBClient({
    endpoint: process.env.DDB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const counters = { get: 0, put: 0, update: 0, transact: 0, query: 0 };
  // 敏感性测试：给每个 DynamoDB 请求额外注入固定延迟，近似真实 DynamoDB 的网络往返（DynamoDB Local 在同一 Docker 网络内）
  const extra = Number(process.env.DDB_EXTRA_LATENCY_MS ?? 0);
  if (extra > 0) {
    client.middlewareStack.add((next) => async (args) => {
      await new Promise((r) => setTimeout(r, extra));
      return next(args);
    }, { step: 'finalizeRequest', name: 'spikeExtraLatency' });
  }

  return {
    counters,

    async createTable() {
      try {
        await client.send(
          new CreateTableCommand({
            TableName: TABLE,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
              { AttributeName: 'PK', AttributeType: 'S' },
              { AttributeName: 'SK', AttributeType: 'S' },
            ],
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
          }),
        );
      } catch (e) {
        if (e.name !== 'ResourceInUseException') throw e;
      }
    },

    /** 预置一个带 2 条既有消息的会话，用于验证 3.8「既有消息与序号计数器不变」 */
    async seedSession(sessionId, t) {
      counters.transact++;
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: { PK: pk(sessionId), SK: 'META', sessionId, seqCounter: 2, lastMessageAt: t } } },
            { Put: { TableName: TABLE, Item: { PK: pk(sessionId), SK: msgSk(1), seq: 1, role: 'user', text: '既有用户消息', createdAt: t, toolCalls: [] } } },
            { Put: { TableName: TABLE, Item: { PK: pk(sessionId), SK: msgSk(2), seq: 2, role: 'assistant', text: '既有助手消息', createdAt: t, toolCalls: [] } } },
          ],
        }),
      );
    },

    /**
     * 追加一条消息：强一致读 seqCounter=n-1 → 事务（META 条件更新为 n + Put MSG#n 且不存在）。
     * 与任务 1.8 的待验证方案同形；冲突时重读重试。计数器只在消息写入成功时推进（3.8）。
     */
    async appendMessage(sessionId, msg) {
      for (let attempt = 0; attempt < 5; attempt++) {
        counters.get++;
        const meta = (await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(sessionId), SK: 'META' }, ConsistentRead: true }))).Item;
        const prev = meta.seqCounter;
        const seq = prev + 1;
        const createdAt = Date.now();
        try {
          counters.transact++;
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: TABLE,
                    Key: { PK: pk(sessionId), SK: 'META' },
                    UpdateExpression: 'SET seqCounter = :n, lastMessageAt = :t',
                    ConditionExpression: 'seqCounter = :prev',
                    ExpressionAttributeValues: { ':n': seq, ':prev': prev, ':t': createdAt },
                  },
                },
                {
                  Put: {
                    TableName: TABLE,
                    Item: { PK: pk(sessionId), SK: msgSk(seq), seq, createdAt, ...msg },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ],
            }),
          );
          return { seq, createdAt };
        } catch (e) {
          if (e.name !== 'TransactionCanceledException') throw e;
        }
      }
      throw new Error('seq allocation conflict');
    },

    async getMeta(sessionId) {
      counters.get++;
      return (await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(sessionId), SK: 'META' }, ConsistentRead: true }))).Item;
    },

    async listMessages(sessionId) {
      counters.query++;
      const r = await doc.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
          ExpressionAttributeValues: { ':pk': pk(sessionId), ':m': 'MSG#' },
          ConsistentRead: true,
        }),
      );
      return r.Items;
    },

    // ---------- 运行控制 RUNCTL ----------

    /** 开始一次生成：absent / idle / 过期 running → running。返回 false 表示已有进行中的生成。 */
    async startRun(sessionId, runId, requestId, t) {
      try {
        counters.put++;
        await doc.send(
          new PutCommand({
            TableName: TABLE,
            Item: {
              PK: pk(sessionId), SK: 'RUNCTL', runId, requestId,
              state: 'running', stopRequested: false, startedAt: t,
              ttl: Math.floor(t / 1000) + 24 * 3600,
            },
            ConditionExpression: 'attribute_not_exists(PK) OR #st = :idle OR startedAt < :stale',
            ExpressionAttributeNames: { '#st': 'state' },
            ExpressionAttributeValues: { ':idle': 'idle', ':stale': t - STALE_RUN_MS },
          }),
        );
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    /** 停止请求：仅当 runId 匹配且 state=running 时 running → stopping。返回是否命中。 */
    async requestStop(sessionId, runId, t) {
      try {
        counters.update++;
        await doc.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk(sessionId), SK: 'RUNCTL' },
            UpdateExpression: 'SET stopRequested = :true, #st = :stopping, stopRequestedAt = :t',
            ConditionExpression: 'runId = :r AND #st = :running',
            ExpressionAttributeNames: { '#st': 'state' },
            ExpressionAttributeValues: { ':true': true, ':stopping': 'stopping', ':running': 'running', ':r': runId, ':t': t },
          }),
        );
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    /** 收尾：running | stopping → idle（仅限本 runId），记录结局。 */
    async finishRun(sessionId, runId, outcome, t) {
      try {
        counters.update++;
        await doc.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk(sessionId), SK: 'RUNCTL' },
            UpdateExpression: 'SET #st = :idle, outcome = :o, endedAt = :t',
            ConditionExpression: 'runId = :r',
            ExpressionAttributeNames: { '#st': 'state' },
            ExpressionAttributeValues: { ':idle': 'idle', ':o': outcome, ':t': t, ':r': runId },
          }),
        );
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    async readRunCtl(sessionId) {
      counters.get++;
      return (
        await doc.send(
          new GetCommand({
            TableName: TABLE,
            Key: { PK: pk(sessionId), SK: 'RUNCTL' },
            ConsistentRead: true,
            ProjectionExpression: 'runId, #st, stopRequested',
            ExpressionAttributeNames: { '#st': 'state' },
          }),
        )
      ).Item;
    },
  };
}

/** 该 runId 是否仍应继续生成：RUNCTL 存在、runId 相同、state=running 且未请求停止。 */
export function isActive(rc, runId) {
  return !!rc && rc.runId === runId && rc.state === 'running' && rc.stopRequested !== true;
}

// 模拟接入服务 Lambda。以 ROLE 区分两个独立的执行环境（两个进程，不共享内存，只经 DynamoDB 通信）：
//   ROLE=chat：POST /sessions/{id}/messages —— 写用户消息 → RUNCTL running → 调用适配层 → 无缓冲转发 → 落库 → 关闭
//   ROLE=stop：POST /sessions/{id}/stop {runId} —— 条件更新 RUNCTL running → stopping，立即返回 202
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { now, readJson, readSse, sendJson, sleep, writeSse } from './common.mjs';
import { isActive, makeStore } from './store.mjs';

const ROLE = process.env.ROLE;
const PORT = Number(process.env.PORT ?? (ROLE === 'stop' ? 7302 : 7301));
const ADAPTER = process.env.ADAPTER_URL ?? 'http://127.0.0.1:7200';
const store = makeStore();

async function handleStop(req, res, sessionId) {
  const receivedAt = now(); // 停止请求到达接入服务的时刻（3.7 计时起点）
  const { runId } = await readJson(req);
  if (!runId) return sendJson(res, 400, { error: 'runId required' });
  const accepted = await store.requestStop(sessionId, runId, Date.now());
  // 未命中（已结束 / runId 不匹配）也返回 202：停止是幂等的，调用方的目标状态「该 run 不在运行」已成立
  sendJson(res, 202, { accepted, receivedAt, writtenAt: now() });
}

async function handleChat(req, res, sessionId) {
  const body = await readJson(req);
  const pollMs = Number(body.pollMs ?? 200);
  const user = await store.appendMessage(sessionId, { role: 'user', text: body.text, toolCalls: [] });
  const runId = randomUUID();
  const requestId = randomUUID();
  if (!(await store.startRun(sessionId, runId, requestId, Date.now()))) {
    return sendJson(res, 409, { error: { code: 'SESSION_BUSY' } });
  }
  // 响应头立即下发 runId：浏览器在收到任何事件之前就能发起带 runId 的停止请求
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-run-id': runId, 'x-user-seq': String(user.seq) });
  res.flushHeaders();

  const ac = new AbortController();
  let accepted = false; // 是否已收到适配层首字节（交接完成）
  let preStop = null;
  const dbg = { gwPolls: 0 };

  // 交接前（Runtime 冷启动 / 调用建立期间）由接入服务自己盯 RUNCTL；交接后不再轮询
  const watcher = (async () => {
    while (!accepted && !ac.signal.aborted) {
      await sleep(pollMs);
      if (accepted || ac.signal.aborted) break;
      dbg.gwPolls++;
      let rc;
      try {
        rc = await store.readRunCtl(sessionId);
      } catch {
        continue;
      }
      if (!accepted && !isActive(rc, runId)) {
        preStop = { detectedAt: now() };
        ac.abort('stop_before_accept');
      }
    }
  })();

  let text = '';
  let deltas = 0;
  const toolCalls = [];
  let completed = null;
  let failure = null;
  try {
    const resp = await fetch(`${ADAPTER}/invocations`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'chat', runId, requestId, sessionId, scenario: body.scenario, pollMs, acceptDelayMs: body.acceptDelayMs ?? 0,
        userMessage: { role: 'user', text: body.text, seq: user.seq, createdAt: user.createdAt },
      }),
    });
    for await (const ev of readSse(resp.body)) {
      accepted = true;
      if (ev.event === 'comment') continue;
      if (ev.event === 'delta') {
        text += ev.data.text;
        deltas++;
        writeSse(res, 'delta', ev.data);
      } else if (ev.event === 'tool_call') {
        toolCalls.push({ name: ev.data.name, order: ev.data.order, status: ev.data.resultStatus, resultSummary: ev.data.resultSummary });
        writeSse(res, 'tool_call', ev.data);
      } else if (ev.event === 'message_started') {
        writeSse(res, 'message_started', { ...ev.data, userSeq: user.seq });
      } else if (ev.event === 'message_completed') {
        completed = ev.data;
        dbg.gwCompletedReceivedAt = now();
        break;
      } else if (ev.event === 'error') {
        failure = ev.data;
        break;
      }
    }
  } catch (e) {
    if (!(preStop && ac.signal.aborted)) failure = { code: 'RUNTIME_ERROR', message: String(e?.message ?? e) };
  }
  accepted = true;
  await watcher;

  const interrupted = preStop ? true : !!completed?.interrupted;
  if (!completed && !preStop && !failure) failure = { code: 'RUNTIME_ERROR', message: 'stream ended without message_completed' };

  // 3.8：没有转发过任何 delta 文本或 tool_call 事件时不写助手消息（序号计数器也不推进）
  const hasContent = text.length > 0 || toolCalls.length > 0;
  let assistantSeq = null;
  if (!failure && hasContent) {
    assistantSeq = (await store.appendMessage(sessionId, { role: 'assistant', text, toolCalls, interrupted })).seq;
  }
  await store.finishRun(sessionId, runId, failure ? 'failed' : interrupted ? 'interrupted' : 'completed', Date.now());
  dbg.gwPersistedAt = now();

  if (failure) {
    writeSse(res, 'error', failure);
  } else {
    writeSse(res, 'message_completed', {
      assistantSeq, interrupted, toolCallCount: toolCalls.length,
      debug: {
        ...completed?.debug, ...dbg, preStop, deltasForwarded: deltas,
        adapterDeltaCount: completed?.deltaCount ?? null,
        source: preStop ? 'gateway_pre_accept' : 'adapter',
      },
    });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    const m = req.url.match(/^\/sessions\/([^/]+)\/(messages|stop)$/);
    if (req.method === 'POST' && m) {
      if (m[2] === 'stop' && ROLE === 'stop') return await handleStop(req, res, m[1]);
      if (m[2] === 'messages' && ROLE === 'chat') return await handleChat(req, res, m[1]);
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error(JSON.stringify({ proc: `gateway-${ROLE}`, error: String(e?.stack ?? e) }));
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    else res.end();
  }
});
server.keepAliveTimeout = 60_000;
server.listen(PORT, () => console.log(JSON.stringify({ proc: `gateway-${ROLE}`, port: PORT })));

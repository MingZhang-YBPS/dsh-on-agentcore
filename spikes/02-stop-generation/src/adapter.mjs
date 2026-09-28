// 模拟 microVM 内的 DSH 适配层：POST /invocations {type:"chat"} → SSE。
// 停止链路：轮询 RUNCTL（强一致 GetItem）→ AbortController.abort()
//   → 取消模型 fetch 流 / 进程组 SIGTERM→SIGKILL / 放弃不响应取消的进程内工具 → 结束 agent loop
//   → message_completed{interrupted:true} → 结束响应 → 后台完成工作空间提交（不计入停止耗时）。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { now, readJson, readSse, sendJson, sleep, writeSse } from './common.mjs';
import { isActive, makeStore } from './store.mjs';

const PORT = Number(process.env.PORT ?? 7200);
const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:7100';
const TOOLS_DIR = path.resolve(import.meta.dirname, '../tools');
const MARK_DIR = process.env.MARK_DIR ?? '/tmp/spike';
const GRACE_MS = Number(process.env.KILL_GRACE_MS ?? 500); // SIGTERM → SIGKILL 宽限期
const HARD_WAIT_MS = Number(process.env.KILL_HARD_WAIT_MS ?? 300); // SIGKILL 后最多等待进程组消失的时间
const INTERRUPTED_COMMIT_MS = Number(process.env.INTERRUPTED_COMMIT_MS ?? 800); // 模拟中断后的工作空间提交耗时
const MAX_TURNS = 8;

const store = makeStore();
const background = new Map(); // sessionId -> Promise（中断后在后台进行的工作空间提交）
let busy = 0;
fs.mkdirSync(MARK_DIR, { recursive: true });

// ---------- 进程组终止 ----------

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

async function waitGroupGone(pgid, ms) {
  const deadline = now() + ms;
  while (now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(10);
  }
  return !groupAlive(pgid);
}

/** SIGTERM 整个进程组 → 宽限期内未退出则 SIGKILL → 最多再等 HARD_WAIT_MS，超时即放弃等待（不阻塞收尾）。 */
async function killGroup(pgid) {
  const t0 = now();
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') return { escalated: false, gone: true, ms: 0 };
  }
  if (await waitGroupGone(pgid, GRACE_MS)) return { escalated: false, gone: true, ms: now() - t0 };
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* 已退出 */
  }
  const gone = await waitGroupGone(pgid, HARD_WAIT_MS);
  return { escalated: true, gone, ms: now() - t0 };
}

const abortPromise = (signal) =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

// ---------- 工具执行 ----------

async function runTool(ctx, call, order) {
  const startedAt = now();
  const base = { name: call.name, order, startedAt };
  fs.writeFileSync(path.join(MARK_DIR, `${ctx.runId}.tool`), call.name);

  if (call.name === 'inproc_slow') {
    // 不可中断的进程内工具：实现不接受 AbortSignal（模拟第三方同步语义的 async 调用）
    const work = sleep(5000).then(() => 'done');
    const r = await Promise.race([work, abortPromise(ctx.signal).then(() => 'aborted')]);
    if (r === 'aborted') {
      return { ...base, status: 'failure', resultSummary: '已被停止生成中断：进程内工具不响应取消，已放弃等待其结果', abandoned: true, endedAt: now() };
    }
    return { ...base, status: 'success', resultSummary: r, endedAt: now() };
  }

  const pidsFile = path.join(MARK_DIR, `${ctx.runId}.pids`);
  // detached:true → 子进程成为新进程组组长（pgid = pid），其后代默认继承该进程组
  const child = spawn('bash', [path.join(TOOLS_DIR, `${call.name}.sh`), pidsFile], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = once(child, 'exit').then(([code, sig]) => ({ code, sig }));
  const first = await Promise.race([exited.then((x) => ({ kind: 'exit', ...x })), abortPromise(ctx.signal).then(() => ({ kind: 'abort' }))]);
  if (first.kind === 'exit') {
    return { ...base, status: first.code === 0 ? 'success' : 'failure', resultSummary: out.slice(0, 10000), endedAt: now() };
  }
  const kill = await killGroup(child.pid);
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  return {
    ...base,
    status: 'failure',
    resultSummary: `已被停止生成中断：进程组已${kill.escalated ? '在 SIGTERM 宽限期后 SIGKILL' : '响应 SIGTERM 退出'}${kill.gone ? '' : '（SIGKILL 后仍未消失，已放弃等待）'}`,
    kill,
    pgid: child.pid,
    endedAt: now(),
  };
}

// ---------- 模型调用 ----------

async function callModel(ctx, turn) {
  const resp = await fetch(`${UPSTREAM}/v1/chat/completions`, {
    method: 'POST',
    signal: ctx.signal,
    headers: { 'content-type': 'application/json', 'x-spike-run': ctx.runId, 'x-spike-scenario': ctx.scenario, 'x-spike-turn': String(turn) },
    body: JSON.stringify({ model: 'spike', stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [] }),
  });
  const calls = new Map();
  for await (const ev of readSse(resp.body)) {
    if (ev.data === '[DONE]') break;
    const choice = ev.data?.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) ctx.emitDelta(d.content);
    // reasoning_content：PoC 默认丢弃，不计为「已产生内容」
    for (const tc of d.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { name: '', arguments: '' };
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  return [...calls.values()];
}

// ---------- 停止信号轮询 ----------

function startPoller(ctx, intervalMs, onStop) {
  let stopped = false;
  let timer = null;
  const stats = { polls: 0, errors: 0, latencies: [] };
  const tick = async () => {
    if (stopped) return;
    const t0 = now();
    let rc;
    let ok = true;
    try {
      rc = await store.readRunCtl(ctx.sessionId);
    } catch {
      ok = false; // 瞬时错误：继续轮询，不当作停止
      stats.errors++;
    }
    stats.latencies.push(now() - t0);
    stats.polls++;
    if (stopped) return;
    if (ok && !isActive(rc, ctx.runId)) {
      stopped = true;
      onStop({ detectedAt: now(), rc });
      return;
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    stats,
  };
}

// ---------- chat 调用 ----------

async function handleChat(p, res) {
  const receivedAt = now();
  let gone = false;
  res.once('close', () => (gone = true));
  if (p.acceptDelayMs) await sleep(p.acceptDelayMs); // 模拟 microVM 冷启动：此期间尚未产生任何字节
  await background.get(p.sessionId); // 上一轮中断后的后台提交完成前不开始新一轮
  if (gone || res.destroyed) {
    // 接入服务已在交接前取消（冷启动期间的停止），不再调用模型
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(': accepted\n\n'); // 交接标志：首字节到达后由适配层负责停止

  const ac = new AbortController();
  const ctx = { runId: p.runId, sessionId: p.sessionId, scenario: p.scenario, signal: ac.signal, emitDelta: null };
  const dbg = { receivedAt, acceptedAt: now() };
  let deltaCount = 0;
  ctx.emitDelta = (text) => {
    if (ac.signal.aborted) return; // 停止命中后不再发出任何 delta
    deltaCount++;
    writeSse(res, 'delta', { text });
  };
  res.on('close', () => {
    if (!res.writableEnded && !ac.signal.aborted) ac.abort('client_gone');
  });

  // 开始前先确认 RUNCTL 仍是本 runId 且 running（防止残留/过期调用继续执行）
  const rc0 = await store.readRunCtl(p.sessionId);
  if (!isActive(rc0, p.runId)) {
    dbg.stopDetectedAt = now();
    dbg.detectedBy = 'initial_check';
    writeSse(res, 'message_completed', { interrupted: true, deltaCount: 0, toolCallCount: 0, debug: dbg });
    res.end();
    return;
  }

  busy++;
  const poller = startPoller(ctx, p.pollMs, ({ detectedAt }) => {
    dbg.stopDetectedAt = detectedAt;
    dbg.detectedBy = 'poll';
    ac.abort('stop_requested');
  });
  writeSse(res, 'message_started', { sessionId: p.sessionId, runId: p.runId, requestId: p.requestId });

  const toolCalls = [];
  let error = null;
  try {
    for (let turn = 0; turn < MAX_TURNS && !ac.signal.aborted; turn++) {
      let calls;
      try {
        calls = await callModel(ctx, turn);
      } catch (e) {
        // abort(reason) 时 fetch / 流读取以 reason 本身拒绝，而不一定是 AbortError，因此以 signal 状态判定
        if (ac.signal.aborted) {
          dbg.modelAbortedAt = now();
          break;
        }
        throw e;
      }
      if (calls.length === 0) break;
      for (const call of calls) {
        const rec = await runTool(ctx, call, toolCalls.length + 1);
        toolCalls.push(rec);
        writeSse(res, 'tool_call', {
          name: rec.name, order: rec.order, inputSummary: call.arguments, resultStatus: rec.status, resultSummary: rec.resultSummary,
          debug: { kill: rec.kill, abandoned: rec.abandoned, pgid: rec.pgid, durationMs: Math.round(rec.endedAt - rec.startedAt) },
        });
        if (ac.signal.aborted) break;
      }
    }
  } catch (e) {
    error = e;
  } finally {
    poller.stop();
  }

  const interrupted = ac.signal.aborted;
  if (error && !interrupted) {
    writeSse(res, 'error', { code: 'RUNTIME_ERROR', message: String(error?.message ?? error) });
    res.end();
    busy--;
    return;
  }
  if (!interrupted) await sleep(50); // 正常结束：先提交工作空间（此处仅模拟），再发 message_completed
  dbg.completedAt = now();
  dbg.polls = poller.stats.polls;
  dbg.pollErrors = poller.stats.errors;
  dbg.pollLatencyMs = poller.stats.latencies;
  writeSse(res, 'message_completed', { interrupted, deltaCount, toolCallCount: toolCalls.length, debug: dbg });
  res.end();

  if (interrupted) {
    // 中断分支：先结束响应，工作空间提交在后台完成；/ping 在此期间返回 HealthyBusy
    const bg = sleep(INTERRUPTED_COMMIT_MS).finally(() => {
      busy--;
      background.delete(p.sessionId);
    });
    background.set(p.sessionId, bg);
  } else {
    busy--;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/ping') return sendJson(res, 200, { status: busy > 0 ? 'HealthyBusy' : 'Healthy' });
    if (req.method === 'POST' && req.url === '/invocations') {
      const p = await readJson(req);
      if (p.type === 'chat') return await handleChat(p, res);
      return sendJson(res, 400, { error: 'unsupported type' });
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error(JSON.stringify({ proc: 'adapter', error: String(e?.stack ?? e) }));
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    else res.end();
  }
});
server.keepAliveTimeout = 60_000;
server.listen(PORT, () => console.log(JSON.stringify({ proc: 'adapter', port: PORT, GRACE_MS, HARD_WAIT_MS })));

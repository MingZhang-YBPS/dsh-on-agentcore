// Spike 02 编排器（扮演浏览器 + 测量）：启动上游模型、适配层、两个接入服务执行环境，
// 按轮询间隔 × 场景矩阵执行停止生成，逐次校验并统计「停止请求到达 → 原流式调用收尾」耗时。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { now, rand, readSse, sleep } from './common.mjs';
import { makeStore } from './store.mjs';

const RESULTS = path.resolve(import.meta.dirname, '../results');
const TAG = process.env.RESULTS_TAG ? `-${process.env.RESULTS_TAG}` : '';
const MARK_DIR = '/tmp/spike';
const INTERVALS = (process.env.POLL_INTERVALS ?? '100,200,500').split(',').map(Number);
const REPEAT = Number(process.env.REPEAT ?? 1); // 每个间隔下场景矩阵重复次数
const LIMIT_MS = 2000;
// 每个间隔下的场景矩阵（stop 类 24 次 + after-stop 2 次）
const MATRIX = [
  ['stream', 8], ['tool-term', 4], ['tool-group', 4], ['inproc', 3], ['empty', 3], ['coldstart', 2],
];
const URL = { upstream: 'http://127.0.0.1:7100', adapter: 'http://127.0.0.1:7200', chat: 'http://127.0.0.1:7301', stop: 'http://127.0.0.1:7302' };

// 整体运行时间护栏：无论发生什么，4.5 分钟后退出（子进程随之被清理）
setTimeout(() => {
  console.error('runner: global timeout, exiting');
  process.exit(3);
}, 270_000).unref();

const children = [];
function startProc(name, file, env) {
  const c = spawn(process.execPath, [path.join(import.meta.dirname, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(c);
  return c;
}
const killAll = () => children.forEach((c) => c.exitCode === null && c.kill('SIGKILL'));
process.on('exit', killAll);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

async function waitUp(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(100);
  }
  throw new Error(`not up: ${url}`);
}

function procAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) Z /.test(stat); // 僵尸进程视为已退出
  } catch {
    return false;
  }
}

async function sendStop(sessionId, runId) {
  const r = await fetch(`${URL.stop}/sessions/${sessionId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) });
  return { status: r.status, ...(await r.json()) };
}

async function waitFile(f, ms) {
  const deadline = now() + ms;
  while (now() < deadline) {
    if (fs.existsSync(f)) return true;
    await sleep(5);
  }
  return false;
}

/** 执行一次对话并按场景在合适时机发起停止；返回原始观测 */
async function converse({ sessionId, scenario, pollMs, staleRunId }) {
  const acceptDelayMs = scenario === 'coldstart' ? 3000 : 0;
  const upstreamScenario = scenario;
  const t0 = now();
  const resp = await fetch(`${URL.chat}/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `用户消息（${scenario}）`, scenario: upstreamScenario, pollMs, acceptDelayMs }),
  });
  const runId = resp.headers.get('x-run-id');
  const userSeq = Number(resp.headers.get('x-user-seq'));
  let stopP = null;
  const fire = (id = runId) => {
    if (!stopP) stopP = sendStop(sessionId, id);
  };
  const deltaTarget = scenario === 'stream' ? rand(5, 15) : 5;
  if (scenario === 'coldstart') setTimeout(fire, rand(100, 500));

  const events = [];
  let text = '';
  let deltas = 0;
  let completed = null;
  let error = null;
  let lastTool = null;
  for await (const ev of readSse(resp.body)) {
    events.push(ev.event);
    if (ev.event === 'message_started') {
      if (scenario === 'empty') setTimeout(fire, rand(100, 500));
      if (['tool-term', 'tool-group', 'inproc'].includes(scenario)) {
        waitFile(path.join(MARK_DIR, `${runId}.tool`), 5000).then(async (ok) => {
          if (!ok) return;
          await sleep(rand(0, 300));
          fire();
        });
      }
    } else if (ev.event === 'delta') {
      text += ev.data.text;
      deltas++;
      if (scenario === 'stream' && deltas === deltaTarget) fire();
      if (scenario === 'after-stop' && deltas === 5) fire(staleRunId);
    } else if (ev.event === 'tool_call') lastTool = ev.data;
    else if (ev.event === 'message_completed') completed = ev.data;
    else if (ev.event === 'error') error = ev.data;
  }
  const clientEndAt = now();
  const stop = stopP ? await stopP : null;
  return { runId, userSeq, t0, clientEndAt, text, deltas, completed, error, stop, events, lastTool };
}

async function verify(store, obs, ctx) {
  const { scenario, sessionId, seedCount } = ctx;
  const fails = [];
  const meta = await store.getMeta(sessionId);
  const msgs = await store.listMessages(sessionId);
  const rc = await store.readRunCtl(sessionId);
  const c = obs.completed;
  if (obs.error) fails.push(`error event: ${JSON.stringify(obs.error)}`);
  if (!c) fails.push('no message_completed');
  if (rc?.state !== 'idle') fails.push(`RUNCTL state=${rc?.state}`);
  const expectedUserSeq = seedCount + 1;
  if (obs.userSeq !== expectedUserSeq) fails.push(`userSeq ${obs.userSeq} != ${expectedUserSeq}`);

  const seedIntact = msgs.filter((m) => m.seq <= 2).map((m) => m.text).join('|') === '既有用户消息|既有助手消息';
  if (!seedIntact) fails.push('seed messages changed');

  if (scenario === 'after-stop') {
    if (obs.stop?.accepted !== false) fails.push('stale runId stop was accepted');
    if (c?.interrupted !== false) fails.push('run with stale stop was interrupted');
    const a = msgs.find((m) => m.seq === expectedUserSeq + 1);
    if (!a || a.interrupted || a.text !== obs.text) fails.push('assistant message mismatch (after-stop)');
    if (meta.seqCounter !== expectedUserSeq + 1) fails.push(`seqCounter ${meta.seqCounter}`);
    return { fails, rc };
  }

  if (!obs.stop?.accepted) fails.push(`stop not accepted: ${JSON.stringify(obs.stop)}`);
  if (c?.interrupted !== true) fails.push('not interrupted');
  const expectEmpty = scenario === 'empty' || scenario === 'coldstart';
  if (expectEmpty) {
    // 3.8：不写助手消息；既有消息（含本轮已先写入的用户消息）与序号计数器不变
    if (c?.assistantSeq !== null) fails.push(`assistantSeq=${c?.assistantSeq} (expected null)`);
    if (msgs.length !== expectedUserSeq) fails.push(`message count ${msgs.length} != ${expectedUserSeq}`);
    if (meta.seqCounter !== expectedUserSeq) fails.push(`seqCounter ${meta.seqCounter} != ${expectedUserSeq}`);
    if (obs.deltas !== 0) fails.push('deltas were forwarded');
  } else {
    const a = msgs.find((m) => m.seq === expectedUserSeq + 1);
    if (!a) fails.push('assistant message missing');
    else {
      if (a.role !== 'assistant' || a.interrupted !== true) fails.push('assistant message not marked interrupted');
      if (a.text !== obs.text) fails.push('persisted text != concatenation of forwarded deltas');
      if (scenario !== 'stream') {
        const last = a.toolCalls.at(-1);
        if (!last || last.status !== 'failure') fails.push('interrupted tool call not recorded as failure');
      }
    }
    if (meta.seqCounter !== expectedUserSeq + 1) fails.push(`seqCounter ${meta.seqCounter}`);
    if (c?.debug?.adapterDeltaCount !== obs.deltas) fails.push(`adapter deltaCount ${c?.debug?.adapterDeltaCount} != client ${obs.deltas}`);
  }
  return { fails, rc };
}

async function postChecks(obs, scenario) {
  const fails = [];
  const extra = {};
  // 工具进程：全部 PID 必须在收尾时已退出（含孙进程）
  const pidsFile = path.join(MARK_DIR, `${obs.runId}.pids`);
  if (fs.existsSync(pidsFile)) {
    const pids = fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number);
    const alive = pids.filter(procAlive);
    extra.toolPids = pids.length;
    extra.toolPidsAlive = alive.length;
    if (alive.length) fails.push(`tool processes still alive: ${alive.join(',')}`);
  } else if (scenario === 'tool-term' || scenario === 'tool-group') fails.push('pids file missing');
  // 上游模型连接：流式阶段被停止时，上游必须观察到客户端断开
  const up = await (await fetch(`${URL.upstream}/debug/${obs.runId}`)).json();
  extra.upstreamRequests = up.length;
  if (scenario === 'stream' || scenario === 'empty') {
    const last = up.at(-1);
    if (!last?.abortedAt) fails.push('upstream request not aborted');
    else extra.upstreamAbortAfterStopMs = last.abortedAt - obs.stop.receivedAt;
  }
  return { fails, extra, up };
}

function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const r0 = (x) => (x == null ? null : Math.round(x));

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.rmSync(MARK_DIR, { recursive: true, force: true });
  fs.mkdirSync(MARK_DIR, { recursive: true });
  const store = makeStore();
  for (let i = 0; i < 50; i++) {
    try {
      await store.createTable();
      break;
    } catch {
      await sleep(200);
    }
  }
  startProc('upstream', 'upstream.mjs', { PORT: '7100' });
  startProc('adapter', 'adapter.mjs', { PORT: '7200', UPSTREAM_URL: URL.upstream, MARK_DIR });
  startProc('gw-chat', 'gateway.mjs', { PORT: '7301', ROLE: 'chat', ADAPTER_URL: URL.adapter });
  startProc('gw-stop', 'gateway.mjs', { PORT: '7302', ROLE: 'stop' });
  await Promise.all([waitUp(`${URL.upstream}/health`), waitUp(`${URL.adapter}/ping`), waitUp(`${URL.chat}/health`), waitUp(`${URL.stop}/health`)]);

  // 预热（模拟热 Lambda / 热 microVM；冷启动分支由 coldstart 场景单独覆盖）
  {
    const sid = randomUUID();
    await store.seedSession(sid, Date.now());
    await converse({ sessionId: sid, scenario: 'after-stop', pollMs: 200, staleRunId: randomUUID() });
  }

  const runsFile = path.join(RESULTS, `runs${TAG}.jsonl`);
  fs.writeFileSync(runsFile, '');
  const rows = [];
  const coldRuns = [];
  const suiteStart = now();
  for (const pollMs of INTERVALS) {
    const list = [];
    for (let k = 0; k < REPEAT; k++) for (const [s, n] of MATRIX) for (let i = 0; i < n; i++) list.push(s);
    list.sort(() => Math.random() - 0.5);
    let lastStreamSession = null;
    const plan = [];
    for (const s of list) {
      plan.push(s);
      if (s === 'stream' && plan.filter((x) => x === 'after-stop').length < 2 * REPEAT) plan.push('after-stop');
    }
    for (const scenario of plan) {
      let sessionId;
      let seedCount = 2;
      let staleRunId;
      if (scenario === 'after-stop') {
        ({ sessionId, staleRunId } = lastStreamSession);
        seedCount = 4; // 2 条既有 + 上一轮用户消息 + 上一轮中断的助手消息
      } else {
        sessionId = randomUUID();
        await store.seedSession(sessionId, Date.now());
      }
      const obs = await converse({ sessionId, scenario, pollMs, staleRunId });
      const v = await verify(store, obs, { scenario, sessionId, seedCount });
      const pc = await postChecks(obs, scenario);
      if (scenario === 'stream') lastStreamSession = { sessionId, staleRunId: obs.runId };
      if (scenario === 'coldstart') coldRuns.push({ runId: obs.runId, at: now(), pollMs });
      const d = obs.completed?.debug ?? {};
      const stopAt = obs.stop?.receivedAt;
      const row = {
        pollMs, scenario, sessionId, runId: obs.runId,
        stopLatencyMs: scenario === 'after-stop' ? null : r0(obs.clientEndAt - stopAt),
        stopWriteMs: stopAt ? r0(obs.stop.writtenAt - stopAt) : null,
        detectMs: d.stopDetectedAt && stopAt ? r0(d.stopDetectedAt - stopAt) : d.preStop && stopAt ? r0(d.preStop.detectedAt - stopAt) : null,
        adapterCleanupMs: d.completedAt && d.stopDetectedAt ? r0(d.completedAt - d.stopDetectedAt) : null,
        gatewayFinalizeMs: d.gwPersistedAt ? r0(obs.clientEndAt - (d.gwCompletedReceivedAt ?? d.preStop?.detectedAt ?? d.gwPersistedAt)) : null,
        source: d.source, detectedBy: d.detectedBy ?? (d.preStop ? 'gateway_pre_accept' : null),
        deltas: obs.deltas, assistantSeq: obs.completed?.assistantSeq ?? null, interrupted: obs.completed?.interrupted ?? null,
        adapterPolls: d.polls ?? null, gwPolls: d.gwPolls ?? null,
        pollGetItemMs: d.pollLatencyMs?.length ? r0(pct(d.pollLatencyMs, 50) * 10) / 10 : null,
        runDurationMs: r0(obs.clientEndAt - obs.t0),
        toolStatus: obs.lastTool?.resultStatus ?? null,
        killEscalated: obs.lastTool?.debug?.kill?.escalated ?? null,
        killGroupGone: obs.lastTool?.debug?.kill?.gone ?? null,
        killMs: r0(obs.lastTool?.debug?.kill?.ms),
        toolAbandoned: obs.lastTool?.debug?.abandoned ?? null,
        ...pc.extra,
        fails: [...v.fails, ...pc.fails],
      };
      rows.push(row);
      fs.appendFileSync(runsFile, JSON.stringify(row) + '\n');
      console.log(`${pollMs}ms ${scenario.padEnd(10)} latency=${row.stopLatencyMs ?? '-'}ms detect=${row.detectMs ?? '-'} cleanup=${row.adapterCleanupMs ?? '-'} fin=${row.gatewayFinalizeMs ?? '-'} ${row.fails.length ? 'FAIL ' + row.fails.join('; ') : 'ok'}`);
    }
  }

  // 冷启动场景的延迟校验：适配层在「冷启动」结束后不得调用上游模型
  const lastCold = Math.max(0, ...coldRuns.map((c) => c.at));
  await sleep(Math.max(0, lastCold + 3500 - now()));
  await sleep(1000); // 等最后一次中断后的后台工作空间提交（800 ms）结束，再检查 /ping 是否回到 Healthy
  for (const c of coldRuns) {
    const up = await (await fetch(`${URL.upstream}/debug/${c.runId}`)).json();
    const row = rows.find((r) => r.runId === c.runId);
    row.upstreamRequestsAfterColdStart = up.length;
    if (up.length) row.fails.push('adapter called model after stop during cold start');
  }
  const ping = await (await fetch(`${URL.adapter}/ping`)).json();

  writeSummary(rows, { suiteMs: now() - suiteStart, ping });
  fs.writeFileSync(runsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const failed = rows.filter((r) => r.fails.length);
  console.log(`done: ${rows.length} runs, ${failed.length} with failures, adapter /ping=${ping.status}`);
  process.exit(failed.length ? 1 : 0);
}

function writeSummary(rows, { suiteMs, ping }) {
  const stopRows = rows.filter((r) => r.stopLatencyMs != null);
  const lines = [];
  lines.push('# Spike 02 结果汇总', '');
  lines.push(`- 运行时：Node ${process.version}（Docker 镜像 node:22.23.3-bookworm-slim）；信号存储：DynamoDB Local 3.3.1（amazon/dynamodb-local:3.3.1，-inMemory）`);
  lines.push(`- 变体：RESULTS_TAG=${process.env.RESULTS_TAG ?? '（无）'}；DDB_EXTRA_LATENCY_MS=${process.env.DDB_EXTRA_LATENCY_MS ?? 0}；容器 PID 1 回收器（--init）：${process.env.NO_INIT === '1' ? '无' : 'tini'}；SIGTERM 宽限 500 ms，SIGKILL 后最多等待 300 ms`);
  lines.push(`- 生成时间：${new Date().toISOString()}；总运行 ${rows.length} 次（停止类 ${stopRows.length} 次），套件耗时 ${(suiteMs / 1000).toFixed(1)} s`);
  lines.push(`- 结束时适配层 /ping：${ping.status}`);
  lines.push(`- 断言失败的运行：${rows.filter((r) => r.fails.length).length}`, '');
  lines.push('## 停止耗时（停止请求到达接入服务 → 原流式调用落库并关闭），单位 ms', '');
  lines.push('| 轮询间隔 | 次数 | P50 | P95 | 最大 | 超过 2 s | 检测 P50 / 最大 | 适配层收尾 P50 / 最大 | 接入服务收尾 P50 / 最大 | 适配层轮询 GetItem P50 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const intervals = [...new Set(rows.map((r) => r.pollMs))];
  for (const p of intervals) {
    const rs = stopRows.filter((r) => r.pollMs === p);
    const L = rs.map((r) => r.stopLatencyMs);
    const D = rs.map((r) => r.detectMs).filter((x) => x != null);
    const C = rs.map((r) => r.adapterCleanupMs).filter((x) => x != null);
    const F = rs.map((r) => r.gatewayFinalizeMs).filter((x) => x != null);
    const G = rs.map((r) => r.pollGetItemMs).filter((x) => x != null);
    lines.push(`| ${p} | ${rs.length} | ${pct(L, 50)} | ${pct(L, 95)} | ${Math.max(...L)} | ${L.filter((x) => x > LIMIT_MS).length} | ${pct(D, 50)} / ${Math.max(...D)} | ${pct(C, 50)} / ${Math.max(...C)} | ${pct(F, 50)} / ${Math.max(...F)} | ${pct(G, 50)} |`);
  }
  const all = stopRows.map((r) => r.stopLatencyMs);
  lines.push(`| 全部 | ${all.length} | ${pct(all, 50)} | ${pct(all, 95)} | ${Math.max(...all)} | ${all.filter((x) => x > LIMIT_MS).length} | | | | |`, '');
  lines.push('## 按场景（全部间隔合并），单位 ms', '');
  lines.push('| 场景 | 说明 | 次数 | P50 | P95 | 最大 |');
  lines.push('|---|---|---|---|---|---|');
  const desc = {
    stream: '模型流式输出中停止（AbortController 取消 fetch）',
    'tool-term': '工具忽略 SIGTERM（宽限期后 SIGKILL）',
    'tool-group': '工具派生孙进程（进程组 SIGTERM）',
    inproc: '进程内工具不响应取消（放弃等待）',
    empty: '推理阶段、尚无正文时停止（3.8）',
    coldstart: '适配层冷启动 3 s 期间停止（交接前由接入服务处理，3.8）',
  };
  for (const s of Object.keys(desc)) {
    const L = stopRows.filter((r) => r.scenario === s).map((r) => r.stopLatencyMs);
    if (L.length) lines.push(`| ${s} | ${desc[s]} | ${L.length} | ${pct(L, 50)} | ${pct(L, 95)} | ${Math.max(...L)} |`);
  }
  lines.push('');
  lines.push('## 工具终止（停止发生在工具执行期间）', '');
  lines.push('| 场景 | 次数 | 记为 failure | 升级 SIGKILL | 进程组在等待期内消失 | 终止耗时 P50 / 最大 ms | 放弃等待（进程内工具） |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of ['tool-term', 'tool-group', 'inproc']) {
    const rs = stopRows.filter((r) => r.scenario === s);
    if (!rs.length) continue;
    const K = rs.map((r) => r.killMs).filter((x) => x != null);
    lines.push(`| ${s} | ${rs.length} | ${rs.filter((r) => r.toolStatus === 'failure').length} | ${rs.filter((r) => r.killEscalated).length} | ${rs.filter((r) => r.killGroupGone).length} | ${K.length ? `${pct(K, 50)} / ${Math.max(...K)}` : '-'} | ${rs.filter((r) => r.toolAbandoned).length} |`);
  }
  lines.push('');
  lines.push('## 轮询请求量（适配层，每个活跃生成）', '');
  lines.push('| 轮询间隔 | 平均轮询次数 / 次生成 | 平均生成时长 ms | 折算 GetItem 次/秒 |');
  lines.push('|---|---|---|---|');
  for (const p of intervals) {
    const rs = rows.filter((r) => r.pollMs === p && r.adapterPolls != null);
    const polls = rs.reduce((a, r) => a + r.adapterPolls, 0);
    const dur = rs.reduce((a, r) => a + r.runDurationMs, 0);
    lines.push(`| ${p} | ${(polls / rs.length).toFixed(1)} | ${Math.round(dur / rs.length)} | ${((polls / dur) * 1000).toFixed(2)} |`);
  }
  lines.push('');
  const afterStop = rows.filter((r) => r.scenario === 'after-stop');
  lines.push(`## runId 匹配`, '', `- after-stop（同一会话下一轮生成中，用上一轮的 runId 发停止）：${afterStop.length} 次，被误中断 ${afterStop.filter((r) => r.interrupted !== false).length} 次`, '');
  const failed = rows.filter((r) => r.fails.length);
  if (failed.length) {
    lines.push('## 失败明细', '');
    for (const r of failed) lines.push(`- ${r.pollMs}ms ${r.scenario} ${r.runId}: ${r.fails.join('; ')}`);
  }
  fs.writeFileSync(path.join(RESULTS, `summary${TAG}.md`), lines.join('\n') + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

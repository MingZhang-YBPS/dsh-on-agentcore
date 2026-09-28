// 模拟上游模型：持续输出 OpenAI 兼容 Chat Completions SSE 的慢速服务。
// 场景由请求头 x-spike-scenario / x-spike-turn 决定；每个 runId 的请求记录可经 GET /debug/{runId} 查询，
// 用于确认适配层的 AbortController 确实关闭了上游连接（abortedAt）。
import http from 'node:http';
import { now } from './common.mjs';

const PORT = Number(process.env.PORT ?? 7100);
const runs = new Map(); // runId -> [{turn, scenario, startedAt, chunksSent, finishedAt, abortedAt}]
const PIECES = ['深度', '求索', '🚀', 'abc ', '\n', 'é', '，', '👩‍💻'];

const TOOL_BY_SCENARIO = {
  'tool-term': 'bash_ignore_term',
  'tool-group': 'bash_spawn_tree',
  inproc: 'inproc_slow',
};

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-spike', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'spike',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** 生成发送计划：[{delayMs, data}] */
function plan(scenario, turn) {
  const p = [{ delayMs: 20, data: chunk({ role: 'assistant', content: '' }) }];
  const content = (n, every) => {
    for (let i = 0; i < n; i++) p.push({ delayMs: every, data: chunk({ content: PIECES[i % PIECES.length] }) });
  };
  const tool = TOOL_BY_SCENARIO[scenario];
  if (tool && turn === 0) {
    content(5, 50);
    p.push({ delayMs: 30, data: chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: '' } }] }) });
    p.push({ delayMs: 20, data: chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }) });
    p.push({ delayMs: 20, data: chunk({ tool_calls: [{ index: 0, function: { arguments: '"run"}' } }] }) });
    p.push({ delayMs: 10, data: chunk({}, 'tool_calls') });
  } else if (scenario === 'empty') {
    // DeepSeek 推理阶段：只有 reasoning_content（适配层默认丢弃），之后才有正文
    for (let i = 0; i < 200; i++) p.push({ delayMs: 50, data: chunk({ reasoning_content: '思考' }) });
    content(20, 50);
    p.push({ delayMs: 10, data: chunk({}, 'stop') });
  } else if (scenario === 'after-stop') {
    content(30, 20);
    p.push({ delayMs: 10, data: chunk({}, 'stop') });
  } else {
    // stream / coldstart / 工具场景的后续轮次：60 秒长流
    content(1200, 50);
    p.push({ delayMs: 10, data: chunk({}, 'stop') });
  }
  p.push({ delayMs: 5, data: 'data: [DONE]\n\n' });
  return p;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/debug/')) {
    const runId = req.url.slice('/debug/'.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(runs.get(runId) ?? []));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  req.resume(); // 丢弃请求体
  const runId = String(req.headers['x-spike-run'] ?? 'unknown');
  const scenario = String(req.headers['x-spike-scenario'] ?? 'stream');
  const turn = Number(req.headers['x-spike-turn'] ?? 0);
  const rec = { turn, scenario, startedAt: now(), chunksSent: 0, finishedAt: null, abortedAt: null };
  if (!runs.has(runId)) runs.set(runId, []);
  runs.get(runId).push(rec);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const steps = plan(scenario, turn);
  let i = 0;
  let timer = null;
  res.on('close', () => {
    clearTimeout(timer);
    if (!rec.finishedAt) rec.abortedAt = now();
  });
  const next = () => {
    if (res.destroyed) return;
    if (i >= steps.length) {
      rec.finishedAt = now();
      res.end();
      return;
    }
    const s = steps[i++];
    timer = setTimeout(() => {
      if (res.destroyed) return;
      res.write(s.data);
      rec.chunksSent++;
      next();
    }, s.delayMs);
  };
  next();
});

server.keepAliveTimeout = 60_000;
server.listen(PORT, () => console.log(JSON.stringify({ proc: 'upstream', port: PORT })));

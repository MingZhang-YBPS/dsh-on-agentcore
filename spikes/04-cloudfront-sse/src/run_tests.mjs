// Spike 04 用例：请求头与鉴权（H*）、SSE 流式与超时（S*），最后从 CloudWatch Logs 统计每个用例触发的源站调用次数。
// 结果：results/cases.jsonl、results/events-{id}.json（逐事件到达时间）、results/summary.md

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(SPIKE_DIR, 'results');
mkdirSync(RESULTS, { recursive: true });

const st = {};
for (const line of readFileSync(join(SPIKE_DIR, '.state', 'state.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) st[m[1]] = m[2].replace(/\\(.)/g, '$1').replace(/^'(.*)'$/, '$1');
}
const region = st.REGION;
// 本地调试用：SPIKE_CF_BASE 覆盖 CloudFront 地址，SPIKE_ONLY 按用例 ID 正则筛选，SPIKE_SKIP_LOGS=1 跳过 CloudWatch 统计
const CF = process.env.SPIKE_CF_BASE ?? `https://${st.DIST_DOMAIN}`;
const FN = (process.env.SPIKE_FN_BASE ?? st.FN_URL).replace(/\/$/, '');
const only = process.env.SPIKE_ONLY ? new RegExp(process.env.SPIKE_ONLY) : null;
const startedAt = Date.now();
const runTag = randomBytes(3).toString('hex');
const rid = (id) => `${id}-${runTag}`;
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const EMPTY_SHA = sha256hex('');
const log = (...a) => console.log(...a);

const signer = new SignatureV4({ service: 'lambda', region, credentials: defaultProvider(), sha256: Hash.bind(null, 'sha256') });

// 直连 Function URL 的 SigV4 签名请求（基线）
async function signedInit(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const query = Object.fromEntries(u.searchParams.entries());
  const req = await signer.sign({
    method,
    protocol: 'https:',
    hostname: u.hostname,
    path: u.pathname,
    query,
    headers: { host: u.hostname, ...headers, ...(body !== undefined ? { 'x-amz-content-sha256': sha256hex(body) } : {}) },
    body,
  });
  const h = { ...req.headers };
  delete h.host;
  return { method, headers: h, body };
}

const rows = [];
const record = (row) => {
  rows.push(row);
  log(`${row.pass ? '✓' : '✗'} ${row.id} ${row.desc} → ${row.status ?? row.error ?? ''}${row.note ? `（${row.note}）` : ''}`);
};

async function fetchJson(url, init) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（错误页） */ }
    return {
      status: r.status,
      ms: Math.round(performance.now() - t0),
      json,
      text: json ? null : text.slice(0, 300),
      xCache: r.headers.get('x-cache'),
      amznError: r.headers.get('x-amzn-errortype'),
    };
  } catch (e) {
    return { status: null, error: `${e.name}: ${e.cause?.code ?? e.message}`, ms: Math.round(performance.now() - t0) };
  }
}

// ---------------- H：请求头、查询串与 OAC 鉴权 ----------------
async function headerCases() {
  if (only && !only.test('H')) return;
  const qs = 'cursor=a%2Bb%3D%3D&path=dir%2Fsub%2Ffile.txt&empty=&x=1';
  const common = { 'x-dsh-token': 'viewer-token-abc', 'x-request-id': 'req-123' };

  let r = await fetchJson(`${CF}/echo?${qs}&rid=${rid('H01')}`, { headers: { ...common, authorization: 'Bearer viewer-jwt' } });
  record({
    id: 'H01', group: 'header', desc: 'GET 经 OAC(always)：查询串原样、自定义头转发、viewer Authorization 被替换', rid: rid('H01'),
    status: r.status, ms: r.ms,
    detail: r.json && {
      rawQueryString: r.json.rawQueryString,
      authorization: r.json.authorization,
      xDshToken: r.json.headers['x-dsh-token'],
      xRequestId: r.json.headers['x-request-id'],
      viaHeaders: Object.keys(r.json.headers).filter((k) => k.startsWith('cloudfront-') || k === 'via' || k.startsWith('x-amz')).sort(),
    },
    // viewer 的 Bearer 不能以 Authorization 到达源站（被 OAC 签名替换，且 Lambda 不把 Authorization 放进 event）
    pass: r.status === 200 && r.json?.rawQueryString?.startsWith(qs) && r.json?.headers['x-dsh-token'] === 'viewer-token-abc'
      && r.json?.authorization?.scheme !== 'Bearer',
    note: r.json ? `源站 event 中 Authorization=${r.json.authorization?.scheme ?? '无'}` : r.text,
  });

  const body = JSON.stringify({ text: '你好，SSE', n: 1 });
  r = await fetchJson(`${CF}/echo?rid=${rid('H02')}`, {
    method: 'POST', headers: { ...common, 'content-type': 'application/json', 'x-amz-content-sha256': sha256hex(body), authorization: 'Bearer viewer-jwt' }, body,
  });
  record({ id: 'H02', group: 'header', desc: 'POST 带正确 x-amz-content-sha256（同时带 Bearer）', rid: rid('H02'), status: r.status, ms: r.ms,
    detail: r.json && { bodySha256: r.json.bodySha256, bodyLength: r.json.bodyLength, authorization: r.json.authorization },
    pass: r.status === 200 && r.json?.bodySha256 === sha256hex(body) });

  r = await fetchJson(`${CF}/echo?rid=${rid('H03')}`, { method: 'POST', headers: { ...common, 'content-type': 'application/json' }, body });
  record({ id: 'H03', group: 'header', desc: 'POST 不带 x-amz-content-sha256', rid: rid('H03'), status: r.status, ms: r.ms,
    detail: { text: r.text, amznError: r.amznError, json: r.json }, pass: r.status === 403, note: r.text?.slice(0, 120) });

  r = await fetchJson(`${CF}/echo?rid=${rid('H04')}`, { method: 'POST', headers: { ...common, 'content-type': 'application/json', 'x-amz-content-sha256': sha256hex('other') }, body });
  record({ id: 'H04', group: 'header', desc: 'POST 带错误的 x-amz-content-sha256', rid: rid('H04'), status: r.status, ms: r.ms,
    detail: { text: r.text, amznError: r.amznError }, pass: r.status === 403, note: r.text?.slice(0, 120) });

  r = await fetchJson(`${CF}/echo?rid=${rid('H05')}`, { method: 'POST', headers: { ...common, 'x-amz-content-sha256': EMPTY_SHA } });
  record({ id: 'H05', group: 'header', desc: 'POST 空请求体 + 空串 sha256', rid: rid('H05'), status: r.status, ms: r.ms, pass: r.status === 200 });

  r = await fetchJson(`${CF}/echo?rid=${rid('H05b')}`, { method: 'POST', headers: common });
  record({ id: 'H05b', group: 'header', desc: 'POST 空请求体、不带 sha256（观察）', rid: rid('H05b'), status: r.status, ms: r.ms,
    detail: { text: r.text }, pass: true, note: `观察值 ${r.status}` });

  r = await fetchJson(`${CF}/echo?rid=${rid('H06')}`, { method: 'DELETE', headers: common });
  record({ id: 'H06', group: 'header', desc: 'DELETE 无请求体、不带 sha256（观察）', rid: rid('H06'), status: r.status, ms: r.ms,
    detail: { text: r.text }, pass: true, note: `观察值 ${r.status}` });

  r = await fetchJson(`${CF}/noov/echo?rid=${rid('H07')}`, { headers: { ...common, authorization: 'Bearer viewer-jwt' } });
  record({ id: 'H07', group: 'header', desc: 'OAC(no-override) + 缓存键含 Authorization，viewer 带 Bearer', rid: rid('H07'), status: r.status, ms: r.ms,
    detail: { text: r.text, amznError: r.amznError, json: r.json }, pass: r.status === 403, note: r.text?.slice(0, 120) });

  r = await fetchJson(`${CF}/noov/echo?rid=${rid('H08')}`, { headers: common });
  record({ id: 'H08', group: 'header', desc: 'OAC(no-override)，viewer 不带 Authorization', rid: rid('H08'), status: r.status, ms: r.ms,
    detail: r.json && { authorization: r.json.authorization }, pass: r.status === 200 });

  r = await fetchJson(`${CF}/nooac/echo?rid=${rid('H09')}`, { headers: common });
  record({ id: 'H09', group: 'header', desc: '源未配置 OAC（AuthType=AWS_IAM 的 Function URL）', rid: rid('H09'), status: r.status, ms: r.ms,
    detail: { text: r.text }, pass: r.status === 403 });

  r = await fetchJson(`${FN}/echo?rid=${rid('H10')}`, { headers: common });
  record({ id: 'H10', group: 'header', desc: '直连 Function URL、未签名（绕过 CloudFront）', rid: rid('H10'), status: r.status, ms: r.ms,
    detail: { text: r.text }, pass: r.status === 403 });

  const a = await fetchJson(`${CF}/echo?same=1&rid=${rid('H11')}`, { headers: common });
  const b = await fetchJson(`${CF}/echo?same=1&rid=${rid('H11')}`, { headers: common });
  record({ id: 'H11', group: 'header', desc: 'CachingDisabled：同一 GET 连发两次都回源', rid: rid('H11'), status: `${a.status}/${b.status}`,
    detail: { xCache: [a.xCache, b.xCache], requestIds: [a.json?.requestId, b.json?.requestId] },
    pass: a.status === 200 && b.status === 200 && a.json?.requestId !== b.json?.requestId && !/Hit/i.test(`${a.xCache}${b.xCache}`) });
}

// ---------------- S：SSE 流式与超时 ----------------
async function sse(id, desc, { base = CF, path = '/sse', params, direct = false, method = 'POST', expect }) {
  if (only && !only.test(id)) return null;
  const q = new URLSearchParams({ ...params, rid: rid(id) }).toString();
  const url = `${base}${path}?${q}`;
  const body = method === 'POST' ? JSON.stringify({ text: 'hello' }) : undefined;
  const headers = {
    accept: 'text/event-stream',
    'accept-encoding': 'gzip, br',
    'x-dsh-token': 'viewer-token-abc',
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const init = direct
    ? await signedInit(url, { method, headers, body })
    : { method, headers: { ...headers, ...(body !== undefined ? { 'x-amz-content-sha256': sha256hex(body) } : {}) }, body };

  const t0 = performance.now();
  const epoch0 = Date.now();
  const out = { id, group: 'sse', desc, rid: rid(id), via: direct ? 'direct' : 'cloudfront', params };
  const events = [];
  let comments = 0;
  let firstChunkMs = null;
  let done = false;
  let lastByteMs = null;
  try {
    const res = await fetch(url, init);
    out.status = res.status;
    out.headersMs = Math.round(performance.now() - t0);
    out.contentType = res.headers.get('content-type');
    out.contentEncoding = res.headers.get('content-encoding');
    out.xCache = res.headers.get('x-cache');
    if (res.status !== 200) {
      out.text = (await res.text()).slice(0, 200);
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        const now = performance.now();
        const nowEpoch = epoch0 + (now - t0);
        firstChunkMs ??= Math.round(now - t0);
        lastByteMs = Math.round(now - t0);
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          if (block.startsWith(':')) { comments++; continue; }
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev === 'delta') {
            const d = JSON.parse(data);
            events.push({ i: d.i, sent: d.t, arrivedRel: Math.round(now - t0), arrivedEpoch: Math.round(nowEpoch) });
          } else if (ev === 'done') done = true;
        }
      }
    }
  } catch (e) {
    out.error = `${e.name}: ${e.cause?.code ?? e.cause?.message ?? e.message}`;
  }
  out.totalMs = Math.round(performance.now() - t0);
  out.firstChunkMs = firstChunkMs;
  out.lastByteMs = lastByteMs;
  out.events = events.length;
  out.comments = comments;
  out.done = done;
  if (events.length > 1) {
    // 相对滞后：以第一个事件为基准，消除本机与 Lambda 的时钟偏差
    const lags = events.map((e) => (e.arrivedRel - events[0].arrivedRel) - (e.sent - events[0].sent));
    const gaps = events.slice(1).map((e, j) => e.arrivedRel - events[j].arrivedRel);
    const sorted = [...lags].sort((x, y) => x - y);
    out.relLagMs = { p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), min: sorted[0] };
    out.interArrivalMs = { min: Math.min(...gaps), max: Math.max(...gaps) };
    const abs = events.map((e) => e.arrivedEpoch - e.sent).sort((x, y) => x - y);
    out.absLagMs = { p50: abs[Math.floor(abs.length / 2)], max: abs.at(-1), note: '含本机与 Lambda 时钟偏差，仅供参考' };
  }
  writeFileSync(join(RESULTS, `events-${id}.json`), JSON.stringify(events));
  out.pass = expect(out);
  record({ ...out, note: `status=${out.status} events=${out.events} hb=${out.comments} done=${out.done} total=${out.totalMs}ms${out.relLagMs ? ` relLag max=${out.relLagMs.max}ms` : ''}${out.error ? ` err=${out.error}` : ''}` });
  return out;
}

const complete = (n) => (o) => o.status === 200 && o.done && o.events === n && !o.contentEncoding;

async function sseCases() {
  // 逐事件到达（先预热一次，避免把 Lambda 冷启动算进首个用例）
  await fetchJson(`${CF}/echo?rid=${rid('warm')}`, {});
  await sse('S01', '20 个事件 / 250 ms 间隔（CloudFront）', { params: { count: 20, intervalMs: 250 }, expect: complete(20) });
  await sse('S01d', '20 个事件 / 250 ms 间隔（直连 Function URL 基线）', { base: FN, direct: true, params: { count: 20, intervalMs: 250 }, expect: complete(20) });
  await sse('S02', '200 个小事件 / 20 ms 间隔（CloudFront）', { params: { count: 200, intervalMs: 20 }, expect: complete(200) });
  await sse('S02d', '200 个小事件 / 20 ms 间隔（直连基线）', { base: FN, direct: true, params: { count: 200, intervalMs: 20 }, expect: complete(200) });
  await sse('S02p', '50 个 4 KB 事件 / 50 ms 间隔（CloudFront）', { params: { count: 50, intervalMs: 50, padBytes: 4096 }, expect: complete(50) });

  // 超时类用例耗时长，并发执行
  await Promise.all([
    sse('S03', 'POST 首字节 25 s（Response timeout 30）', { params: { firstDelayMs: 25000, count: 3, intervalMs: 100 }, expect: complete(3) }),
    sse('S04', 'POST 首字节 35 s（Response timeout 30）', { params: { firstDelayMs: 35000, count: 3, intervalMs: 100 }, expect: (o) => o.status === 504 }),
    sse('S04g', 'GET 首字节 35 s（Response timeout 30，观察是否重试源站）', { method: 'GET', params: { firstDelayMs: 35000, count: 3, intervalMs: 100 }, expect: (o) => o.status === 504 }),
    sse('S05', 'POST 先发头与 ": accepted"，随后静默 35 s（Response timeout 30）', { params: { early: 1, firstDelayMs: 35000, count: 3, intervalMs: 100 }, expect: (o) => !o.done }),
    sse('S05m', 'POST 3 个事件后静默 35 s 再发 3 个（Response timeout 30）', { params: { count: 6, intervalMs: 100, gapAfter: 2, gapMs: 35000 }, expect: (o) => !o.done }),
    sse('S06', 'POST 先发头，静默 70 s 期间每 10 s 心跳（Response timeout 30）', { params: { early: 1, firstDelayMs: 70000, heartbeatMs: 10000, count: 3, intervalMs: 100 }, expect: (o) => complete(3)(o) && o.comments >= 7 }),
    sse('S07', 'POST 首字节 45 s（Response timeout 60）', { path: '/t60/sse', params: { firstDelayMs: 45000, count: 3, intervalMs: 100 }, expect: complete(3) }),
    sse('S08', 'POST 先发头，静默 65 s（Response timeout 60）', { path: '/t60/sse', params: { early: 1, firstDelayMs: 65000, count: 3, intervalMs: 100 }, expect: (o) => !o.done }),
    sse('S09', 'POST 持续 180 s：每 10 s 心跳，其间零星事件（Response timeout 30）', { params: { early: 1, firstDelayMs: 0, heartbeatMs: 10000, count: 4, intervalMs: 100, gapAfter: 1, gapMs: 180000 }, expect: (o) => complete(4)(o) && o.totalMs >= 180000 }),
  ]);
}

// ---------------- 源站调用次数 ----------------
async function originInvocations() {
  const cw = new CloudWatchLogsClient({ region });
  const counts = {};
  const ends = {};
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 12 && stable < 2; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    for (const k of Object.keys(counts)) delete counts[k];
    let nextToken;
    do {
      const r = await cw.send(new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${st.FN_NAME}`,
        startTime: startedAt - 60000,
        filterPattern: `{ $.spike04 = "invoke" || $.spike04 = "end" }`,
        nextToken,
      }));
      for (const e of r.events ?? []) {
        const m = e.message.match(/\{"spike04".*\}/);
        if (!m) continue;
        const j = JSON.parse(m[0]);
        if (!j.rid?.endsWith(runTag)) continue;
        if (j.spike04 === 'invoke') counts[j.rid] = (counts[j.rid] ?? 0) + 1;
        else ends[j.rid] = j;
      }
      nextToken = r.nextToken;
    } while (nextToken);
    const total = Object.values(counts).reduce((a, b) => a + b, 0) + Object.keys(ends).length;
    stable = total === last ? stable + 1 : 0;
    last = total;
  }
  return { counts, ends };
}

await headerCases();
await sseCases();
log('统计源站调用次数（CloudWatch Logs）…');
const { counts, ends } = process.env.SPIKE_SKIP_LOGS ? { counts: {}, ends: {} } : await originInvocations();
for (const r of rows) {
  r.originInvocations = counts[r.rid] ?? 0;
  if (ends[r.rid]) r.originEnd = ends[r.rid];
}
const s04g = rows.find((r) => r.id === 'S04g');
const s04 = rows.find((r) => r.id === 'S04');
rows.push({ id: 'R01', group: 'retry', desc: 'POST 首字节超时后 CloudFront 不重试源站（S04 源站调用次数 = 1）', detail: s04?.originInvocations, pass: s04?.originInvocations === 1 });
// 下游断开后源站函数的行为：是否感知 close / error、是否继续跑到结束
for (const id of ['S04', 'S05', 'S05m', 'S08', 'S06']) {
  const r = rows.find((x) => x.id === id);
  const e = r?.originEnd;
  rows.push({
    id: `R03-${id}`, group: 'retry', desc: `${id} 源站视角：下游断开是否被感知、函数是否继续运行到结束（观察）`,
    detail: e ? { elapsedMs: e.elapsedMs, closedAt: e.closedAt, errorAt: e.errorAt, error: e.error, writes: e.writes, writesAfterClose: e.writesAfterClose, writeErrors: e.writeErrors } : null,
    pass: Boolean(e),
  });
}
rows.push({ id: 'R02', group: 'retry', desc: 'GET 首字节超时后 CloudFront 按 ConnectionAttempts 重试源站（S04g 源站调用次数，观察）', detail: s04g?.originInvocations, pass: true });

writeFileSync(join(RESULTS, 'cases.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const md = ['# Spike 04 结果摘要', '', `- 区域：${region}；分发：${st.DIST_DOMAIN}；运行时间：${new Date(startedAt).toISOString()}`, `- 用例 ${rows.length}，不符合预期 ${rows.filter((r) => !r.pass).length}`, ''];
md.push('| 用例 | 说明 | 状态 | 耗时 ms | 首块 ms | 事件 / 心跳 / done | 相对滞后 p50/p95/max ms | 到达间隔 min/max ms | 源站调用 | 细节 | 符合 |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const lag = r.relLagMs ? `${r.relLagMs.p50}/${r.relLagMs.p95}/${r.relLagMs.max}` : '';
  const ia = r.interArrivalMs ? `${r.interArrivalMs.min}/${r.interArrivalMs.max}` : '';
  const ev = r.group === 'sse' ? `${r.events} / ${r.comments} / ${r.done}` : '';
  const det = JSON.stringify(r.detail ?? r.error ?? r.text ?? '').replace(/\|/g, '\\|').slice(0, 220);
  md.push(`| ${r.id} | ${r.desc} | ${r.status ?? ''} | ${r.totalMs ?? r.ms ?? ''} | ${r.firstChunkMs ?? ''} | ${ev} | ${lag} | ${ia} | ${r.originInvocations ?? ''} | ${det} | ${r.pass ? '✓' : '✗'} |`);
}
writeFileSync(join(RESULTS, 'summary.md'), md.join('\n') + '\n');
const failed = rows.filter((r) => !r.pass);
log(`\n${rows.length} cases, ${failed.length} not as expected`);
process.exitCode = failed.length ? 1 : 0;

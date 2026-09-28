// Spike 04 源站：Lambda Function URL（AuthType=AWS_IAM, InvokeMode=RESPONSE_STREAM, Node.js 22）。
// 路径前缀（/t60、/noov、/nooac）只用于 CloudFront 行为路由，这里忽略。
//
//   /echo  回显方法、路径、查询串、请求头（Authorization 只回显方案）、请求体长度与 sha256
//   /sse   按查询参数生成 SSE：
//          firstDelayMs  调用 HttpResponseStream.from 之前的等待（此前源站不发送任何字节）
//          early=1       先发响应头和 ": accepted"，再进入 firstDelayMs 等待
//          count / intervalMs  事件数与事件间隔
//          gapAfter / gapMs    第 gapAfter 个事件之后停顿 gapMs
//          heartbeatMs   停顿（含 firstDelayMs 在 early=1 时）期间每隔多久发一次 ": hb" 注释
//          padBytes      每个事件附加的填充字节数
// 每次调用在日志中输出一行 {"spike04":"invoke", rid, ...}，供客户端统计 CloudFront 是否重试了源站请求。

import { createHash } from 'node:crypto';

let invocations = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 处理函数等流 finish 后再返回。正文先 write 再 end()：实测 HttpResponseStream.from 之后直接 end(body) 会得到 502 Internal Server Error
const finish = (s, body) => new Promise((resolve, reject) => {
  s.on('finish', resolve);
  s.on('error', reject);
  if (body !== undefined) s.write(body);
  s.end();
});

function stripPrefix(p) {
  return p.replace(/^\/(t60|noov|nooac)(?=\/)/, '');
}

function authScheme(v) {
  if (!v) return null;
  const scheme = v.split(' ')[0];
  return { scheme, hasCredential: v.includes('Credential='), length: v.length };
}

function bodyBytes(event) {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
}

export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  invocations += 1;
  const path = stripPrefix(event.rawPath ?? '/');
  const q = event.queryStringParameters ?? {};
  const startedAt = Date.now();
  console.log(JSON.stringify({
    spike04: 'invoke',
    rid: q.rid ?? null,
    path: event.rawPath,
    method: event.requestContext?.http?.method,
    requestId: context.awsRequestId,
    startedAt,
  }));

  if (path === '/echo') {
    const h = { ...event.headers };
    const auth = authScheme(h.authorization);
    delete h.authorization;
    for (const k of Object.keys(h)) if (/secret|signature|security/i.test(k)) h[k] = `<${String(h[k]).length} chars>`;
    const body = bodyBytes(event);
    const out = {
      method: event.requestContext?.http?.method,
      rawPath: event.rawPath,
      rawQueryString: event.rawQueryString,
      queryStringParameters: event.queryStringParameters ?? null,
      authorization: auth,
      headers: h,
      bodyLength: body.length,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      invocation: invocations,
      requestId: context.awsRequestId,
      sourceIp: event.requestContext?.http?.sourceIp,
    };
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    await finish(s, JSON.stringify(out));
    return;
  }

  if (path === '/sse') {
    const num = (k, d) => (q[k] !== undefined ? Number(q[k]) : d);
    const firstDelayMs = num('firstDelayMs', 0);
    const early = q.early === '1';
    const count = num('count', 10);
    const intervalMs = num('intervalMs', 100);
    const gapAfter = num('gapAfter', -1);
    const gapMs = num('gapMs', 0);
    const heartbeatMs = num('heartbeatMs', 0);
    const pad = 'x'.repeat(num('padBytes', 0));
    const headers = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      'x-accel-buffering': 'no',
    };

    // 观察下游（CloudFront / 客户端）断开后函数是否感知、是否继续运行：
    // 记录 responseStream 的 close / error 事件与写入异常，结束时输出一行 {"spike04":"end"}。
    const obs = { closedAt: null, errorAt: null, error: null, writeErrors: 0, writesAfterClose: 0, writes: 0 };
    responseStream.on('close', () => { obs.closedAt ??= Date.now() - startedAt; });
    responseStream.on('error', (e) => { obs.errorAt ??= Date.now() - startedAt; obs.error ??= `${e.code ?? e.name}`; });

    let s = null;
    const open = () => {
      s = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers });
      s.on('error', (e) => { obs.errorAt ??= Date.now() - startedAt; obs.error ??= `${e.code ?? e.name}`; });
    };
    const write = (chunk) => {
      obs.writes++;
      if (obs.closedAt !== null || obs.errorAt !== null) obs.writesAfterClose++;
      try { s.write(chunk); } catch (e) { obs.writeErrors++; obs.error ??= `${e.code ?? e.name}`; }
    };
    // 停顿期间按 heartbeatMs 发注释行；heartbeatMs=0 表示完全静默
    const wait = async (ms) => {
      if (!heartbeatMs || !s) return sleep(ms);
      const until = Date.now() + ms;
      for (;;) {
        const left = until - Date.now();
        if (left <= 0) return;
        await sleep(Math.min(heartbeatMs, left));
        if (until - Date.now() > 0) write(`: hb ${Date.now()}\n\n`);
      }
    };

    if (early) {
      open();
      write(`: accepted ${Date.now()}\n\n`);
    }
    await wait(firstDelayMs);
    if (!s) open();
    for (let i = 0; i < count; i++) {
      write(`event: delta\ndata: ${JSON.stringify({ i, t: Date.now(), pad })}\n\n`);
      if (i === gapAfter) await wait(gapMs);
      else if (i < count - 1) await sleep(intervalMs);
    }
    write(`event: done\ndata: ${JSON.stringify({ t: Date.now(), elapsedMs: Date.now() - startedAt })}\n\n`);
    // 下游已断开时 finish 可能永远不触发，最多等 5 秒
    await Promise.race([finish(s).catch(() => {}), sleep(5000)]);
    console.log(JSON.stringify({ spike04: 'end', rid: q.rid ?? null, elapsedMs: Date.now() - startedAt, ...obs }));
    return;
  }

  const s = awslambda.HttpResponseStream.from(responseStream, { statusCode: 404, headers: { 'content-type': 'text/plain' } });
  await finish(s, 'not found');
});

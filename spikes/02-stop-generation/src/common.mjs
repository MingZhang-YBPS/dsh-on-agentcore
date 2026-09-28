// 公共工具：跨进程可比较的毫秒时钟、SSE 读写、JSON 请求体解析
import { performance } from 'node:perf_hooks';

/** 墙钟毫秒（亚毫秒精度）。同一容器内的多个进程共享同一时钟，可直接相减。 */
export const now = () => performance.timeOrigin + performance.now();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** 写一个 SSE 事件；连接已关闭时静默返回 false。 */
export function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

/**
 * 解析 fetch 响应体中的 SSE 流。
 * 产出 {event, data}；注释行（以 ':' 开头）产出 {event: 'comment'}，用于识别「首字节已到达」。
 * data 为 JSON 时解析为对象，否则保留原文（如 OpenAI 的 `[DONE]`）。
 */
export async function* readSse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const dataLines = [];
      let comment = false;
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) comment = true;
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length === 0) {
        if (comment) yield { event: 'comment' };
        continue;
      }
      const text = dataLines.join('\n');
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON（如 [DONE]）保持原文 */
      }
      yield { event, data };
    }
  }
}

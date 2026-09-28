// AgentCore Runtime 探针（NODE_22 direct code deployment，esbuild 打包为单文件）。
// 满足 HTTP 协议契约：GET /ping、POST /invocations，监听 0.0.0.0:8080。
//
// /invocations 请求体：
//   { sessionId, peerSessionId, bucket, table, region, workspaceRoleArn,
//     scopedCredentials?: { accessKeyId, secretAccessKey, sessionToken } }
// 返回 JSON：收到的请求头（敏感值打码）、环境变量名、执行角色身份与用例、
// 子进程（模拟 DSH 工具）拿到的身份、注入凭证下的用例矩阵。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { makeClients, scopedMatrix, execRoleCases } from '../matrix.mjs';

const SENSITIVE = /token|auth|secret|credential|signature|cookie|key/i;

// 子进程模式：模拟 DSH 工具进程，用默认凭证链调用 GetCallerIdentity。
if (process.argv.includes('--child-identity')) {
  const { sts } = makeClients(process.env.AWS_REGION);
  sts
    .send(new GetCallerIdentityCommand({}))
    .then((r) => process.stdout.write(JSON.stringify({ ok: true, Arn: r.Arn })))
    .catch((e) => process.stdout.write(JSON.stringify({ ok: false, error: `${e.name}: ${e.message}` })));
} else {
  startServer();
}

function childIdentity() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [process.argv[1], '--child-identity'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      try {
        resolve({ code, ...JSON.parse(out) });
      } catch {
        resolve({ code, ok: false, raw: out.slice(0, 300), stderr: err.slice(0, 300) });
      }
    });
  });
}

function redactHeaders(h) {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, SENSITIVE.test(k) && !/session-id/i.test(k) ? '***' : v]),
  );
}

function envSummary() {
  const names = Object.keys(process.env).sort();
  const shown = {};
  for (const n of names) {
    if (/^AWS_|^AGENTCORE|BEDROCK/i.test(n)) {
      shown[n] = SENSITIVE.test(n) ? '***' : process.env[n];
    }
  }
  return { names, aws: shown };
}

async function handleInvocation(req, payload) {
  const t0 = Date.now();
  const { sessionId, peerSessionId, bucket, table, region, workspaceRoleArn, scopedCredentials } = payload;
  const ctx = { bucket, table, own: sessionId, peer: peerSessionId, workspaceRoleArn, tag: 'probe' };

  const exec = await execRoleCases(makeClients(region), ctx);
  const child = await childIdentity();
  const scoped = scopedCredentials
    ? await scopedMatrix(makeClients(region, scopedCredentials), ctx)
    : null;

  return {
    receivedAt: t0,
    durationMs: Date.now() - t0,
    runtimeSessionIdHeader: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ?? null,
    headers: redactHeaders(req.headers),
    env: envSummary(),
    node: process.version,
    arch: process.arch,
    uid: process.getuid?.(),
    pid: process.pid,
    execRole: exec,
    childIdentity: child,
    scopedCases: scoped,
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/invocations') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', async () => {
        try {
          const out = await handleInvocation(req, JSON.parse(raw));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (e) {
          console.error(JSON.stringify({ level: 'error', msg: 'invocation failed', error: `${e.name}: ${e.message}` }));
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `${e.name}: ${e.message}` }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', msg: 'probe listening', port: 8080 })));
}

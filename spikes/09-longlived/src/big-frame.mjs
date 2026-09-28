// 客户端 → AgentCore 方向的 64 KB 帧上限：经 CloudFront /api/remote.mux 分别发送 60 KB 与 70 KB 的单帧文本，
// 以及 70 KB 拆成两个分片的消息，观察连接是否被以 1009 关闭。
// 浏览器的 WebSocket API 总是单帧发送，因此「单帧 70 KB」对应用户在界面里提交超大内容的情形。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const exec = promisify(execFile)
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')]))
const st = readEnv(join(DIR, '..', '06-webui-tunnel', '.state', 'state.env'))
const aws = async (...a) => JSON.parse((await exec('aws', [...a, '--output', 'json'])).stdout || 'null')
const pass = `Aa1!${randomBytes(10).toString('hex')}`
await aws('cognito-idp', 'admin-create-user', '--user-pool-id', st.POOL_ID, '--username', 'bigframe', '--message-action', 'SUPPRESS').catch(() => {})
await aws('cognito-idp', 'admin-set-user-password', '--user-pool-id', st.POOL_ID, '--username', 'bigframe', '--password', pass, '--permanent')
const tok = (await aws('cognito-idp', 'admin-initiate-auth', '--user-pool-id', st.POOL_ID, '--client-id', st.CLIENT_ID, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=bigframe,PASSWORD=${pass}`)).AuthenticationResult.AccessToken

function trial(label, send) {
  return new Promise((res) => {
    const ws = new WebSocket(`wss://${st.DIST_DOMAIN}/api/remote.mux`, { headers: { cookie: `dsh_token=${tok}` } })
    const r = { label }
    const t = setTimeout(() => { r.result = ws.readyState === WebSocket.OPEN ? 'still-open' : 'not-open'; ws.terminate(); res(r) }, 15000)
    ws.on('open', () => setTimeout(() => send(ws), 1500))
    ws.on('close', (code, reason) => { clearTimeout(t); r.result = 'closed'; r.code = code; r.reason = String(reason); res(r) })
    ws.on('error', (e) => { r.error = e.message })
  })
}
// 发送的是非 DSH 协议的填充文本：DSH 收到后可能自行关闭连接，所以另以 60 KB 单帧作对照
const pad = (n) => 'x'.repeat(n)
const out = []
out.push(await trial('60 KB 单帧', (ws) => ws.send(pad(60 * 1024))))
out.push(await trial('70 KB 单帧', (ws) => ws.send(pad(70 * 1024))))
out.push(await trial('70 KB 分两帧', (ws) => { ws.send(pad(35 * 1024), { fin: false }); ws.send(pad(35 * 1024), { fin: true }) }))
console.log(JSON.stringify(out, null, 1))
writeFileSync(join(DIR, 'results', 'big-frame.json'), JSON.stringify(out, null, 1))

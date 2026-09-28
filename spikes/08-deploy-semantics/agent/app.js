// 探针 agent（AgentCore NODE_22 直接代码部署，CommonJS）。满足 HTTP 协议契约：GET /ping、POST /invocations。
// POST /invocations 请求体 {op}：
//   write {data}  把 data 写入 /mnt/workspace/marker.txt（session storage）
//   read          返回 marker.txt 内容（不存在为 null）
//   info          返回本 microVM 的标识：boot_id、进程启动时间、环境变量 MARK、代码修订 CODE_REV
const http = require('node:http')
const fs = require('node:fs')
const CODE_REV = 'r1' // 修改此处即改变代码包内容（用于「只改代码」的用例）
const MOUNT = process.env.MOUNT_PATH || '/mnt/workspace'
const STARTED = new Date().toISOString()
const bootId = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return null } })()

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }))
  }
  if (req.method !== 'POST' || !req.url.startsWith('/invocations')) { res.writeHead(404); return res.end() }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    let out
    try {
      const q = JSON.parse(body || '{}')
      const f = `${MOUNT}/marker.txt`
      if (q.op === 'write') { fs.writeFileSync(f, String(q.data)); out = { ok: true } }
      else if (q.op === 'read') out = { data: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null, files: fs.existsSync(MOUNT) ? fs.readdirSync(MOUNT) : null }
      else out = {}
      Object.assign(out, { bootId, started: STARTED, mark: process.env.MARK ?? null, codeRev: CODE_REV, authHeader: Boolean(req.headers.authorization) })
    } catch (e) { out = { error: e.message } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
}).listen(8080, '0.0.0.0')

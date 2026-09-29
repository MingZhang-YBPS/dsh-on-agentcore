// 每用户 Runtime（DshPerUser 栈，EFS 访问点挂在 USER_HOME）的进程入口：先等 EFS 挂载出现，再加载适配器 app.js。
// 实测（2026-09-29）：AgentCore 在挂载 EFS 之前就启动了进程，启动时 /mnt/workspace 还不存在（ENOENT），约 0.9 s 后才挂上；
// 适配器启动即创建工作区目录，会因此失败（EACCES）并退出，调用方看到 424「Runtime initialization time exceeded」。
// 只打进 adapter-per-user.zip（build-adapter.sh 第 5 步），DshPoc 的 adapter.zip 不变。
// 环境变量：USER_HOME（挂载点，默认 /mnt/workspace）MOUNT_WAIT_MS（默认 20000；AgentCore 要求 30 s 内完成初始化）

import { readFileSync } from 'node:fs'

const mount = process.env.USER_HOME || '/mnt/workspace'
const timeoutMs = Number(process.env.MOUNT_WAIT_MS || 20000)
const log = (level, msg, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }))
const mounted = () => {
  try { return readFileSync('/proc/mounts', 'utf8').split('\n').some((l) => l.split(' ')[1] === mount) } catch { return false }
}

const t0 = Date.now()
while (!mounted()) {
  if (Date.now() - t0 > timeoutMs) {
    log('error', 'filesystem not mounted', { mount, waitedMs: Date.now() - t0 })
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 100))
}
log('info', 'filesystem mounted', { mount, waitedMs: Date.now() - t0 })
await import('./app.js')

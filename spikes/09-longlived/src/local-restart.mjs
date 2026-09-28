// 本机对照：不经过 AgentCore / CloudFront，用 Spike 06 的本机环境（适配器 + dsh web + 本地网关 + 模拟模型）
// 复现「页面打开时后端进程重启（相当于 microVM 回收）→ 页面自动重连 → 不刷新发消息 → 刷新页面」。
// 用来区分刷新后的「历史加载失败」来自 DSH 本身还是 AgentCore 链路。
// 需要在 Spike 06 的运行目录（npm ci 过）里执行：cd ~/spike06-run && node <本文件>
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const S06 = process.env.S06_DIR ?? join(process.env.HOME, 'spike06-run')
const { startDev } = await import(join(S06, 'src', 'test', 'dev.mjs'))
const WIN = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/spike07-ui'
const winPath = execFileSync('wslpath', ['-w', WIN], { encoding: 'utf8' }).trim()
cpSync(join(DIR, 'ui', 'long.mjs'), join(WIN, 'long.mjs'))
const out = 'X-local-restart'
for (const f of readdirSync(WIN).filter((f) => f.startsWith(out))) rmSync(join(WIN, f), { force: true })
const root = mkdtempSync(join(tmpdir(), 'spike09-local-'))
let dev = await startDev({ root, hardening: true, gatewayPort: 8000 })
const p = promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node long.mjs http://localhost:8000/ watch ${out} - 2`], { timeout: 900000 }).catch((e) => e)
while (!existsSync(join(WIN, `${out}-ready.png`))) await new Promise((r) => setTimeout(r, 1000))
await new Promise((r) => setTimeout(r, 3000))
// 模拟回收：停掉适配器（DSH 收到 SIGTERM，DSH_HOME 做最终同步），网关也一起停，然后在同一持久目录上重新启动
await dev.stop()
await new Promise((r) => setTimeout(r, 2000))
dev = await startDev({ root, hardening: true, gatewayPort: 8000 })
writeFileSync(join(WIN, `${out}.go`), '')
await p
const res = JSON.parse(readFileSync(join(WIN, `${out}.json`), 'utf8'))
for (const e of res.timeline) if (!(e.kind === 'state' && !e.hints?.length && e.tag.startsWith('t+'))) console.log(JSON.stringify(e))
writeFileSync(join(DIR, 'results', `${out}.json`), JSON.stringify(res, null, 1))
for (const f of readdirSync(WIN).filter((f) => f.startsWith(`${out}-`) && f.endsWith('.png'))) cpSync(join(WIN, f), join(DIR, 'results', f))
await dev.stop()
process.exit(0)

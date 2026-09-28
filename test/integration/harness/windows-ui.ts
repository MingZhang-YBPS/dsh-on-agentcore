// 在 Windows 侧 Edge 上运行浏览器用例（WSL 里没有浏览器依赖库）。
// 前置：WIN_UI_DIR（WSL 路径，默认 /mnt/c/Users/zhang/dsh-poc-ui）下已 `npm i playwright-core@1.63.0`（Windows 侧 npm）。
// 必须异步执行：网关跑在测试进程的事件循环里，同步等待会让浏览器请求全部卡住。

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './local-env.js'

export const WIN_UI_DIR = process.env.WIN_UI_DIR ?? '/mnt/c/Users/zhang/dsh-poc-ui'
export const windowsUiAvailable = (): boolean => existsSync(join(WIN_UI_DIR, 'node_modules', 'playwright-core'))

export interface UiCase { id: string; desc: string; pass: boolean; note?: string; error?: string; [k: string]: unknown }
export interface UiResult { phase: string; cases: UiCase[]; net?: unknown }

/** 运行 test/e2e/ui/<script>，参数原样传给脚本；结果 JSON 与截图拷到 resultsDir */
export async function runWindowsUi(script: string, args: string[], out: string, resultsDir: string, timeoutMs = 600_000): Promise<UiResult> {
  const winPath = execFileSync('wslpath', ['-w', WIN_UI_DIR], { encoding: 'utf8' }).trim()
  cpSync(join(REPO, 'test', 'e2e', 'ui', script), join(WIN_UI_DIR, script))
  for (const f of readdirSync(WIN_UI_DIR).filter((f) => f === `${out}.json` || f.startsWith(`${out}-`))) rmSync(join(WIN_UI_DIR, f), { force: true })
  try {
    await promisify(execFile)('cmd.exe', ['/c', `cd /d ${winPath} && node ${script} ${args.join(' ')}`], { timeout: timeoutMs, maxBuffer: 1 << 26 })
  } catch { /* 用例失败时脚本非零退出，结果仍在 json 里 */ }
  mkdirSync(resultsDir, { recursive: true })
  for (const f of readdirSync(WIN_UI_DIR).filter((f) => f.startsWith(`${out}-`) && f.endsWith('.png'))) cpSync(join(WIN_UI_DIR, f), join(resultsDir, f))
  const file = join(WIN_UI_DIR, `${out}.json`)
  if (!existsSync(file)) throw new Error(`browser suite produced no result (${script} ${args.join(' ')})`)
  cpSync(file, join(resultsDir, `${out}.json`))
  return JSON.parse(readFileSync(file, 'utf8')) as UiResult
}

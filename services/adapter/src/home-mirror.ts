// DSH_HOME 镜像。
// DSH 用 link() 做「不覆盖的原子发布」（会话日志、附件），而 AgentCore 托管 session storage 不支持硬链接
// （Spike 06 实测 errno -524）。因此 DSH_HOME 放在 microVM 本地磁盘，由适配器镜像到持久目录：
// 启动时从持久目录恢复，运行中每 intervalMs 把变化复制回去，退出前再同步一次。profiles/ 不镜像
// （DSH 每次启动按安装目录重建，其中是指向安装目录的符号链接）。
// 复制使用「写临时文件 + rename」；持久目录里多出的文件（本地已删除）会被删除。
// 变化判断使用纳秒级 mtime/ctime 与大小，避免同一毫秒内的连续写入被漏掉。

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const MIRROR_EXCLUDE_TOP: ReadonlySet<string> = new Set(['profiles'])
const TMP_SUFFIX = '.mirror-tmp'

interface Entry { dir: boolean; link: boolean; size: bigint; mtimeNs: bigint; ctimeNs: bigint }

function walk(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>()
  const rec = (dir: string): void => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      const rel = relative(root, p)
      if (MIRROR_EXCLUDE_TOP.has(rel.split(sep)[0] as string) || n.endsWith(TMP_SUFFIX)) continue
      let s
      try { s = lstatSync(p, { bigint: true }) } catch { continue }
      if (s.isDirectory()) { out.set(rel, { dir: true, link: false, size: 0n, mtimeNs: 0n, ctimeNs: 0n }); rec(p) }
      else if (s.isFile() || s.isSymbolicLink()) out.set(rel, { dir: false, link: s.isSymbolicLink(), size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs })
    }
  }
  rec(root)
  return out
}

export interface RestoreResult { restored: number }

/** 把持久目录的顶层条目（profiles/ 除外）复制到本地 DSH_HOME */
export function restoreHome(persistDir: string, localDir: string): RestoreResult {
  mkdirSync(localDir, { recursive: true })
  if (!existsSync(persistDir)) return { restored: 0 }
  let n = 0
  for (const name of readdirSync(persistDir)) {
    if (MIRROR_EXCLUDE_TOP.has(name) || name.endsWith(TMP_SUFFIX)) continue
    cpSync(join(persistDir, name), join(localDir, name), { recursive: true, verbatimSymlinks: true, force: true, preserveTimestamps: true })
    n++
  }
  return { restored: n }
}

export interface MirrorStats { syncs: number; copied: number; deleted: number; errors: number; lastSyncAt: number | null; lastSyncMs: number | null }
export interface HomeMirror { stats: MirrorStats; syncOnce(): void; stop(): void }
type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void

export function startHomeMirror({ localDir, persistDir, intervalMs = 2000, log = () => {}, autoStart = true }: { localDir: string; persistDir: string; intervalMs?: number; log?: Log; autoStart?: boolean }): HomeMirror {
  mkdirSync(persistDir, { recursive: true })
  const stats: MirrorStats = { syncs: 0, copied: 0, deleted: 0, errors: 0, lastSyncAt: null, lastSyncMs: null }
  // 基线：启动时本地目录刚从持久目录恢复，两者一致，不必再全部写一遍
  let last = walk(localDir)
  const syncOnce = (): void => {
    const t0 = Date.now()
    const now = walk(localDir)
    // 先删后写：同一路径从文件变成目录（或反过来）时，先清掉旧形态
    for (const [rel, info] of last) {
      const cur = now.get(rel)
      if (cur && cur.dir === info.dir) continue
      try { rmSync(join(persistDir, rel), { recursive: true, force: true }); stats.deleted++ } catch { stats.errors++ }
    }
    for (const [rel, info] of now) {
      const prev = last.get(rel)
      const dst = join(persistDir, rel)
      try {
        if (info.dir) { if (!prev || !prev.dir) mkdirSync(dst, { recursive: true }); continue }
        if (prev && !prev.dir && prev.link === info.link && prev.size === info.size && prev.mtimeNs === info.mtimeNs && prev.ctimeNs === info.ctimeNs) continue
        mkdirSync(dirname(dst), { recursive: true })
        if (info.link) {
          rmSync(dst, { force: true })
          symlinkSync(readlinkSync(join(localDir, rel)), dst)
        } else {
          const tmp = `${dst}${TMP_SUFFIX}`
          copyFileSync(join(localDir, rel), tmp)
          renameSync(tmp, dst)
        }
        stats.copied++
      } catch (e) {
        stats.errors++
        log('warn', 'home mirror copy failed', { rel, error: (e as Error).message })
        now.delete(rel) // 下一轮重试
      }
    }
    last = now
    stats.syncs++
    stats.lastSyncAt = Date.now()
    stats.lastSyncMs = stats.lastSyncAt - t0
  }
  const timer = autoStart ? setInterval(syncOnce, intervalMs) : null
  timer?.unref()
  return { stats, syncOnce, stop() { if (timer) clearInterval(timer); syncOnce() } }
}

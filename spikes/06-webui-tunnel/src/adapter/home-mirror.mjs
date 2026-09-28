// DSH_HOME 镜像：DSH 的会话日志、附件以 link() 做「不覆盖的原子发布」（session-persistence-jsonl、attachment-local），
// 而 AgentCore 托管 session storage 不支持硬链接（阶段 2 实测 errno -524）。因此 DSH_HOME 放在 microVM 本地磁盘，
// 由适配器把它镜像到持久目录：启动时从持久目录恢复，运行中每 intervalMs 把变化的文件复制回去，退出前再同步一次。
// profiles/ 不镜像（DSH 每次启动时按安装目录重建，其中是指向安装目录的符号链接）。
//
// 复制使用「写临时文件 + rename」，rename 在 session storage 上受支持；持久目录里多出的文件（本地已删除）会被删除。

import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync, renameSync, rmSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const EXCLUDE_TOP = new Set(['profiles'])

function walk(root) {
  const out = new Map()
  const rec = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      const rel = relative(root, p)
      if (EXCLUDE_TOP.has(rel.split('/')[0])) continue
      let s
      try { s = lstatSync(p) } catch { continue }
      if (s.isDirectory()) { out.set(rel, { dir: true }); rec(p) } else if (s.isFile() || s.isSymbolicLink()) out.set(rel, { size: s.size, mtimeMs: s.mtimeMs, link: s.isSymbolicLink() })
    }
  }
  rec(root)
  return out
}

export function restoreHome(persistDir, localDir) {
  mkdirSync(localDir, { recursive: true })
  if (!existsSync(persistDir)) return { restored: 0 }
  let n = 0
  for (const name of readdirSync(persistDir)) {
    if (EXCLUDE_TOP.has(name)) continue
    cpSync(join(persistDir, name), join(localDir, name), { recursive: true, verbatimSymlinks: true, force: true, preserveTimestamps: true })
    n++
  }
  return { restored: n }
}

export function startHomeMirror({ localDir, persistDir, intervalMs = 2000, log = () => {} }) {
  mkdirSync(persistDir, { recursive: true })
  let last = new Map()
  const stats = { syncs: 0, copied: 0, deleted: 0, errors: 0, lastSyncAt: null }
  const syncOnce = () => {
    const now = walk(localDir)
    for (const [rel, info] of now) {
      const prev = last.get(rel)
      const dst = join(persistDir, rel)
      try {
        if (info.dir) { if (!prev) mkdirSync(dst, { recursive: true }); continue }
        if (prev && !prev.dir && prev.size === info.size && prev.mtimeMs === info.mtimeMs) continue
        mkdirSync(dirname(dst), { recursive: true })
        if (info.link) {
          rmSync(dst, { force: true })
          symlinkSync(readlinkSync(join(localDir, rel)), dst)
        } else {
          const tmp = `${dst}.mirror-tmp`
          copyFileSync(join(localDir, rel), tmp)
          renameSync(tmp, dst)
        }
        stats.copied++
      } catch (e) {
        stats.errors++
        log('warn', 'home mirror copy failed', { rel, error: e.message })
        now.delete(rel) // 下一轮重试
      }
    }
    for (const [rel, info] of last) {
      if (now.has(rel)) continue
      try { rmSync(join(persistDir, rel), { recursive: Boolean(info.dir), force: true }); stats.deleted++ } catch { stats.errors++ }
    }
    last = now
    stats.syncs++
    stats.lastSyncAt = Date.now()
  }
  // 启动时以持久目录的现状为基线，避免把刚恢复的文件全部再写一遍
  last = walk(localDir)
  const timer = setInterval(syncOnce, intervalMs)
  timer.unref()
  return { stats, syncOnce, stop() { clearInterval(timer); syncOnce() } }
}

// Feature: poc, Property 9: DSH_HOME 镜像保真
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { restoreHome, startHomeMirror } from '@dsh-poc/adapter/home-mirror'
import { RUNS } from '../arbitraries/index.js'

function snapshot(root: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const rec = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const rel = relative(root, p)
      if (rel.split(sep)[0] === 'profiles') continue
      const s = lstatSync(p)
      if (s.isDirectory()) { out.set(rel + '/', null); rec(p) } else out.set(rel, readFileSync(p).toString('base64'))
    }
  }
  if (existsSync(root)) rec(root)
  return out
}

// 路径取自很小的名字集合，保证操作之间经常互相覆盖（同名覆盖、删除后重建、文件 ↔ 目录）
const name = fc.constantFrom('a', 'b', '会话', 'x y', '.hidden', 'profiles')
const relPath = fc.array(name, { minLength: 1, maxLength: 3 }).map((xs) => xs.join('/'))
const op = fc.oneof(
  fc.record({ kind: fc.constant('write' as const), path: relPath, data: fc.uint8Array({ maxLength: 64 }) }),
  fc.record({ kind: fc.constant('rewriteSameSize' as const), path: relPath }),
  fc.record({ kind: fc.constant('rm' as const), path: relPath }),
  fc.record({ kind: fc.constant('mkdir' as const), path: relPath }),
  fc.record({ kind: fc.constant('sync' as const) }),
)

function apply(root: string, o: { kind: string; path?: string; data?: Uint8Array }): void {
  const p = o.path ? join(root, o.path) : root
  try {
    if (o.kind === 'write') {
      mkdirSync(join(p, '..'), { recursive: true })
      if (existsSync(p) && statSync(p).isDirectory()) rmSync(p, { recursive: true })
      writeFileSync(p, o.data ?? new Uint8Array())
    } else if (o.kind === 'rewriteSameSize') {
      if (existsSync(p) && statSync(p).isFile()) { const b = readFileSync(p); writeFileSync(p, Buffer.from(b.map((x) => (x + 1) & 0xff))) }
    } else if (o.kind === 'rm') rmSync(p, { recursive: true, force: true })
    else if (o.kind === 'mkdir') { if (existsSync(p) && !statSync(p).isDirectory()) rmSync(p); mkdirSync(p, { recursive: true }) }
  } catch { /* 父路径是文件等非法组合：跳过该操作 */ }
}

describe('Property 9: DSH_HOME 镜像保真', () => {
  it('任意增删改序列：每次同步后镜像与源一致（排除 profiles/）；从镜像恢复得到相同的树', () => {
    fc.assert(fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
      const base = mkdtempSync(join(tmpdir(), 'p09-'))
      try {
        const local = join(base, 'local')
        const persist = join(base, 'persist')
        mkdirSync(local)
        const m = startHomeMirror({ localDir: local, persistDir: persist, autoStart: false })
        for (const o of ops) {
          if (o.kind === 'sync') { m.syncOnce(); expect(snapshot(persist)).toEqual(snapshot(local)) } else apply(local, o)
        }
        m.stop()
        expect(snapshot(persist)).toEqual(snapshot(local))
        expect(existsSync(join(persist, 'profiles'))).toBe(false)
        const restored = join(base, 'restored')
        restoreHome(persist, restored)
        expect(snapshot(restored)).toEqual(snapshot(persist))
        expect(m.stats.errors).toBe(0)
      } finally { rmSync(base, { recursive: true, force: true }) }
    }), { numRuns: RUNS.roundTrip })
  })

  it('启动基线：刚从持久目录恢复时不重复写入', () => {
    const base = mkdtempSync(join(tmpdir(), 'p09b-'))
    try {
      const persist = join(base, 'persist')
      mkdirSync(join(persist, 'sessions'), { recursive: true })
      writeFileSync(join(persist, 'sessions', 's.jsonl'), 'x')
      const local = join(base, 'local')
      restoreHome(persist, local)
      const m = startHomeMirror({ localDir: local, persistDir: persist, autoStart: false })
      m.syncOnce()
      expect(m.stats.copied).toBe(0)
      expect(snapshot(persist)).toEqual(snapshot(local))
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})

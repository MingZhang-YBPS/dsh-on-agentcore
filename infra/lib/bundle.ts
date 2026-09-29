// 合成时用 esbuild 打包隧道 Lambda（ESM 单文件，依赖全部打进去，不依赖 Lambda 运行时自带的 SDK 版本）。
// 输出只取决于源码与锁定的依赖版本，输入不变时资产哈希不变。

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** entry：index.ts（共享 Runtime，DshPoc）或 per-user.ts（每用户 Runtime，DshPerUser）；输出文件都叫 index.mjs（handler 为 index.handler） */
export function bundleTunnel(entry: 'index.ts' | 'per-user.ts' = 'index.ts'): string {
  const outdir = join(REPO_ROOT, 'infra', 'build', entry === 'index.ts' ? 'tunnel' : 'tunnel-per-user')
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  buildSync({
    entryPoints: [join(REPO_ROOT, 'services', 'tunnel', 'src', entry)],
    outfile: join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    conditions: ['source'],
    mainFields: ['module', 'main'],
    // 被打包的 CJS 依赖会调用 require()
    banner: { js: "import { createRequire as __dshCreateRequire } from 'node:module'; const require = __dshCreateRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  })
  return outdir
}

import { defineConfig } from 'vitest/config'

// 三个测试项目：unit（各包 test/ 下）、property（test/properties/）、integration（test/integration/，需要 DSH 与浏览器）
// resolve.conditions 使用 source：直接从各工作区包的 src/*.ts 运行，不需要先构建
// 注意：测试运行在 ssr 环境，必须同时设置 ssr.resolve.conditions，否则会解析到可能过期的 dist/
const conditions = ['source', 'import', 'node', 'default']
export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'infra/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'property', include: ['test/properties/**/*.test.ts'], testTimeout: 120_000 } },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 900_000, hookTimeout: 300_000, fileParallelism: false } },
    ],
  },
})

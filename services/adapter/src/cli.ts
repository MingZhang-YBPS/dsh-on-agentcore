// 进程入口（本地 `node dist/cli.js`；部署包中由 esbuild 打包为 app.js）
import { runFromCli } from './main.js'

runFromCli()

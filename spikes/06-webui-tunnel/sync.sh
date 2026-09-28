#!/usr/bin/env bash
# 把 spike 同步到原生 Linux 文件系统再运行（WSL 的 /mnt/<盘符> 经 DrvFs 加载 DSH 的 500 多个包很慢，见 Spike 05）。
# 用法：./sync.sh <命令...>，例如 ./sync.sh node src/test/dev.mjs
# 运行目录：$SPIKE06_RUN_DIR（默认 ~/spike06-run），node_modules 在该目录保留，lock 变化时重新 npm ci。
# 命令结束后把 results/ 与 package-lock.json 拷回仓库。
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="${SPIKE06_RUN_DIR:-$HOME/spike06-run}"
mkdir -p "$RUN"
rsync -a --delete --exclude node_modules --exclude results --exclude .state --exclude build "$SRC"/ "$RUN"/
cd "$RUN"
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json || package.json -nt node_modules/.package-lock.json ]]; then
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
fi
[[ -f "$SRC/package-lock.json" ]] || cp package-lock.json "$SRC/package-lock.json"
set +e
"$@"
rc=$?
set -e
if [[ -d results ]]; then mkdir -p "$SRC/results"; rsync -a results/ "$SRC/results/"; fi
exit $rc

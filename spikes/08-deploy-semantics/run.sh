#!/usr/bin/env bash
# 同步到原生文件系统（~/spike08-run）后运行驱动或 cdk 命令；结束后把 results/ 拷回仓库。
# 用法：./run.sh node src/run.mjs    |    ./run.sh npx cdk destroy DshPocSpike08 --force
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="${SPIKE08_RUN_DIR:-$HOME/spike08-run}"
mkdir -p "$RUN"
rsync -a --exclude node_modules --exclude results --exclude cdk.out --exclude .agent-build "$SRC"/ "$RUN"/
cd "$RUN"
if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; cp package-lock.json "$SRC/"; fi
fi
export AWS_REGION="${AWS_REGION:-$(aws configure get region)}" AWS_PAGER=""
set +e
"$@"
rc=$?
set -e
mkdir -p "$SRC/results"; [[ -d results ]] && rsync -a results/ "$SRC/results/"
exit $rc

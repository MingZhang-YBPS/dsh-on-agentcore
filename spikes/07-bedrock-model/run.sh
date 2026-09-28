#!/usr/bin/env bash
# 把 Spike 06 与 Spike 07 同步到原生 Linux 文件系统再运行（DrvFs 上加载 DSH 很慢，见 Spike 05）。
# 用法：./run.sh <命令...>，例如 ./run.sh node spikes/07-bedrock-model/src/run-local.mjs
# 运行目录 $SPIKE07_RUN_DIR（默认 ~/spike07-run），保留两个 spike 的 node_modules；结束后把 07 的 results/ 拷回仓库。
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${SPIKE07_RUN_DIR:-$HOME/spike07-run}"
mkdir -p "$RUN/spikes"
for s in 06-webui-tunnel 07-bedrock-model; do
  rsync -a --delete --exclude node_modules --exclude results --exclude .state "$SRC/spikes/$s"/ "$RUN/spikes/$s"/
  if [[ ! -d "$RUN/spikes/$s/node_modules" || "$RUN/spikes/$s/package-lock.json" -nt "$RUN/spikes/$s/node_modules/.package-lock.json" ]]; then
    (cd "$RUN/spikes/$s" && npm ci --no-audit --no-fund --loglevel=error)
  fi
done
[[ -d "$SRC/spikes/07-bedrock-model/.state" ]] && rsync -a "$SRC/spikes/07-bedrock-model/.state/" "$RUN/spikes/07-bedrock-model/.state/"
cd "$RUN"
set +e
"$@"
rc=$?
set -e
mkdir -p "$SRC/spikes/07-bedrock-model/results"
[[ -d "$RUN/spikes/07-bedrock-model/results" ]] && rsync -a "$RUN/spikes/07-bedrock-model/results/" "$SRC/spikes/07-bedrock-model/results/"
[[ -d "$RUN/spikes/07-bedrock-model/.state" ]] && rsync -a "$RUN/spikes/07-bedrock-model/.state/" "$SRC/spikes/07-bedrock-model/.state/"
exit $rc

#!/usr/bin/env bash
# 安装锁定版本的 DSH 并运行全部用例。不调用任何云服务。
# 在 WSL 的 /mnt/<盘符> 上运行时，模块加载经 DrvFs 很慢（实测 DSH 启动约 32 s，原生 ext4 约 1.2 s），
# 因此这种情况下先把 spike 复制到 $HOME 下的临时目录运行，再把 results/ 拷回来。
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$SPIKE_DIR"
if [[ "$SPIKE_DIR" == /mnt/* ]]; then
  RUN_DIR="$(mktemp -d "$HOME/spike05-run-XXXXXX")"
  cp -r "$SPIKE_DIR"/{package.json,package-lock.json,bridge,src} "$RUN_DIR"/
  trap 'rm -rf "$RUN_DIR"' EXIT
fi
cd "$RUN_DIR"
npm ci --no-audit --no-fund --loglevel=error
set +e
node src/run_tests.mjs
rc=$?
set -e
if [[ "$RUN_DIR" != "$SPIKE_DIR" ]]; then rm -rf "$SPIKE_DIR/results"; cp -r "$RUN_DIR/results" "$SPIKE_DIR/results"; fi
exit $rc

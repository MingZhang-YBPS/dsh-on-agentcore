#!/usr/bin/env bash
# Spike 02 一键运行：构建镜像 → 启动 DynamoDB Local → 在 Node 22 容器内跑 runner → 清理。
# 不访问任何 AWS 资源。整体运行时间上限 5 分钟；EXIT/INT/TERM trap 保证容器与网络被删除。
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=dsh-spike02:local
DDB_IMAGE=amazon/dynamodb-local:3.3.1
SUFFIX="$$"
NET="spike02-net-${SUFFIX}"
DDB="spike02-ddb-${SUFFIX}"
RUNNER="spike02-runner-${SUFFIX}"

cleanup() {
  docker rm -f "$RUNNER" "$DDB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p results
docker build -q -t "$IMAGE" . >/dev/null
docker network create "$NET" >/dev/null
docker run -d --rm --name "$DDB" --network "$NET" "$DDB_IMAGE" -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null

# --init：以 tini 作为 PID 1 回收被收养的孙进程（否则僵尸进程会让「进程组是否已消失」的判断一直为真）。
# NO_INIT=1 可去掉 --init，用于对照验证这一点。
INIT_FLAG="--init"
[[ "${NO_INIT:-0}" == "1" ]] && INIT_FLAG=""
timeout --kill-after=10 290 docker run --rm ${INIT_FLAG} --name "$RUNNER" --network "$NET" \
  -e DDB_ENDPOINT="http://${DDB}:8000" \
  -e POLL_INTERVALS="${POLL_INTERVALS:-100,200,500}" \
  -e REPEAT="${REPEAT:-1}" \
  -e RESULTS_TAG="${RESULTS_TAG:-}" \
  -e DDB_EXTRA_LATENCY_MS="${DDB_EXTRA_LATENCY_MS:-0}" \
  -e NO_INIT="${NO_INIT:-0}" \
  -v "$PWD/results:/app/results" \
  "$IMAGE" node src/runner.mjs

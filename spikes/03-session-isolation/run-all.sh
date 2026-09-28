#!/usr/bin/env bash
# 创建 → 用例矩阵 → 清理 → 拉取 CloudTrail（EXIT trap 保证清理）。
# CloudTrail 事件历史在资源删除后仍可按角色 ARN 查询，因此放在清理之后，避免 Runtime 空等计费。

source "$(dirname "$0")/common.sh"
cd "$SPIKE_DIR"

CT_STATE="$(mktemp)"
cleaned=0
finish() {
  if [[ $cleaned == 0 ]]; then ./cleanup.sh; fi
  rm -f "$CT_STATE"
}
trap finish EXIT

./setup.sh
set +e
node src/run_tests.mjs
TEST_RC=$?
set -e

cp "$STATE_FILE" "$CT_STATE"
./cleanup.sh
cleaned=1

set +e
SPIKE_STATE_FILE="$CT_STATE" node src/cloudtrail.mjs
CT_RC=$?
set -e

echo "run_tests exit=$TEST_RC cloudtrail exit=$CT_RC"
exit $(( TEST_RC != 0 ? TEST_RC : CT_RC ))

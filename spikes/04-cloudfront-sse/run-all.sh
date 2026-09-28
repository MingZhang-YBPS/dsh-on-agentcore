#!/usr/bin/env bash
# 创建 → 用例 → 清理（EXIT trap 保证清理）。CloudFront 创建与删除各需 5–15 分钟，整体约 25–40 分钟。

source "$(dirname "$0")/common.sh"
cd "$SPIKE_DIR"
trap './cleanup.sh' EXIT

./setup.sh
node src/run_tests.mjs

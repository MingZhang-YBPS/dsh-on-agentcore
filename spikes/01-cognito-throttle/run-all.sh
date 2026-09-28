#!/usr/bin/env bash
# 一键执行：创建资源 → 三组用例 → 拉取触发器日志 → 清理（无论成功失败都会清理）。
set -euo pipefail
cd "$(dirname "$0")"
trap './cleanup.sh' EXIT
./setup.sh
python3 run_tests.py
CASES_FILE=cases.jsonl python3 collect_logs.py
SPIKE_SUITE=burst python3 run_tests.py
CASES_FILE=cases-burst.jsonl python3 collect_logs.py
SPIKE_SUITE=adminonly python3 run_tests.py
CASES_FILE=cases-adminonly.jsonl python3 collect_logs.py

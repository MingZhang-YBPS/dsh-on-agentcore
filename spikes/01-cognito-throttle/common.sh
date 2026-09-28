# shellcheck shell=bash
# Spike 01 公共变量与函数。被 setup.sh / run-tests.sh / collect-logs.sh / cleanup.sh 引用。

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SPIKE_DIR/.state"
STATE_FILE="$STATE_DIR/state.env"
RESULTS_DIR="$SPIKE_DIR/results"
PREFIX="dsh-poc-spike-"

ROLE_NAME="${PREFIX}cognito-trigger-role"
PRE_FN="${PREFIX}preauth"
POST_FN="${PREFIX}postauth"
POOL_NAME="${PREFIX}throttle-pool"
CLIENT_NAME="${PREFIX}throttle-client"

# 测试用户名（均为临时用户，随 User Pool 一起删除）
USER_OK="spikeuser"
USER_LOCKED="lockeduser"      # PreAuthentication 触发器对其抛错，模拟锁定拒绝
USER_BRUTE="bruteuser"        # 用于观察 Cognito 内建的连续失败锁定
USER_ADMIN="adminflowuser"    # 用于观察 ADMIN_USER_PASSWORD_AUTH（接入服务代理登录）路径

# 不猜测区域：必须来自环境变量或 aws configure。
resolve_region() {
  local r="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [[ -z "$r" ]]; then r="$(aws configure get region 2>/dev/null || true)"; fi
  if [[ -z "$r" ]]; then
    echo "ERROR: 未配置 AWS 区域（AWS_REGION / AWS_DEFAULT_REGION / aws configure），停止。" >&2
    exit 1
  fi
  echo "$r"
}

REGION="$(resolve_region)"
export AWS_REGION="$REGION"
export AWS_PAGER=""

load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

save_state() { # key value
  mkdir -p "$STATE_DIR"
  touch "$STATE_FILE"
  grep -v "^$1=" "$STATE_FILE" > "$STATE_FILE.tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

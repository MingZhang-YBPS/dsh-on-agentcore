# shellcheck shell=bash
# Spike 06 阶段 2（AgentCore）公共变量与函数。被 aws/*.sh 引用。
set -euo pipefail

AWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_DIR="$(cd "$AWS_DIR/.." && pwd)"
STATE_DIR="$SPIKE_DIR/.state"
STATE_FILE="$STATE_DIR/state.env"
BUILD_DIR="${SPIKE06_BUILD_DIR:-$HOME/spike06-build}"
PREFIX="dsh-poc-spike-06-"
EXEC_ROLE_NAME="${PREFIX}exec-role"
RUNTIME_NAME="dsh_poc_spike_06_web"
CODE_KEY="code/adapter.zip"
MOUNT_PATH="/mnt/workspace"

resolve_region() {
  local r="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  [[ -z "$r" ]] && r="$(aws configure get region 2>/dev/null || true)"
  [[ -z "$r" ]] && { echo "ERROR: 未配置 AWS 区域" >&2; exit 1; }
  echo "$r"
}
REGION="$(resolve_region)"
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${PREFIX}${ACCOUNT_ID}-${REGION}"

load_state() { [[ -f "$STATE_FILE" ]] && source "$STATE_FILE" || true; }
save_state() {
  mkdir -p "$STATE_DIR"; touch "$STATE_FILE"
  grep -v "^$1=" "$STATE_FILE" > "$STATE_FILE.tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$STATE_FILE.tmp"; mv "$STATE_FILE.tmp" "$STATE_FILE"
}
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

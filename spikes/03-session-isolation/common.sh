# shellcheck shell=bash
# Spike 03 公共变量与函数。被 setup.sh / run-all.sh / cleanup.sh 引用。

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SPIKE_DIR/.state"
STATE_FILE="$STATE_DIR/state.env"
RESULTS_DIR="$SPIKE_DIR/results"
BUILD_DIR="$SPIKE_DIR/build"
PREFIX="dsh-poc-spike-03-"

EXEC_ROLE_NAME="${PREFIX}exec-role"          # AgentCore Runtime 执行角色（microVM 内默认凭证）
GW_ROLE_NAME="${PREFIX}gateway-sim-role"     # 模拟接入服务 Lambda 角色
WS_ROLE_NAME="${PREFIX}workspace-role"       # 由接入服务带会话标签 AssumeRole 的工作空间访问角色
TABLE_NAME="${PREFIX}table"
RUNTIME_NAME="dsh_poc_spike_03_probe"        # AgentCore 名称只允许 [a-zA-Z0-9_]
CODE_KEY="code/probe.zip"

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

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${PREFIX}${ACCOUNT_ID}-${REGION}"

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

# shellcheck shell=bash
# Spike 07 AgentCore 部分的公共变量与函数。被 aws/*.sh 引用。
set -euo pipefail

AWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_DIR="$(cd "$AWS_DIR/.." && pwd)"
S06_DIR="$(cd "$SPIKE_DIR/../06-webui-tunnel" && pwd)"
STATE_DIR="$SPIKE_DIR/.state"
STATE_FILE="$STATE_DIR/state.env"
BUILD_DIR="${SPIKE07_BUILD_DIR:-$HOME/spike07-build}"
PREFIX="dsh-poc-spike-07-"
EXEC_ROLE_NAME="${PREFIX}exec-role"
RUNTIME_NAME="dsh_poc_spike_07_model"
CODE_KEY="code/adapter.zip"
MOUNT_PATH="/mnt/workspace"
TAG="dsh-poc-spike-07"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[[ -z "$REGION" ]] && { echo "ERROR: 未配置 AWS 区域" >&2; exit 1; }
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${PREFIX}${ACCOUNT_ID}-${REGION}"

load_state() { [[ -f "$STATE_FILE" ]] && source "$STATE_FILE" || true; }
save_state() {
  mkdir -p "$STATE_DIR"; touch "$STATE_FILE"
  grep -v "^$1=" "$STATE_FILE" > "$STATE_FILE.tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$STATE_FILE.tmp"; mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# 端点面 → OpenAI 兼容 base URL 与 SigV4 服务名
surface_base() { case "$1" in bedrock-runtime) echo "https://bedrock-runtime.$REGION.amazonaws.com/openai/v1" ;; bedrock-mantle) echo "https://bedrock-mantle.$REGION.api.aws/v1" ;; esac; }
surface_service() { case "$1" in bedrock-runtime) echo bedrock ;; bedrock-mantle) echo bedrock-mantle ;; esac; }

wait_ready() {
  local status=""
  for _ in $(seq 1 120); do
    status="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" --query status --output text)"
    case "$status" in READY) return 0 ;; *FAILED) aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" --output json >&2; return 1 ;; esac
    sleep 5
  done
  echo "Runtime 未就绪：$status" >&2; return 1
}

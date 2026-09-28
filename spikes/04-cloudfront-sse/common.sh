# shellcheck shell=bash
# Spike 04 公共变量与函数。被 setup.sh / run-all.sh / cleanup.sh 引用。

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SPIKE_DIR/.state"
STATE_FILE="$STATE_DIR/state.env"
RESULTS_DIR="$SPIKE_DIR/results"
BUILD_DIR="$SPIKE_DIR/build"
PREFIX="dsh-poc-spike-04-"

ROLE_NAME="${PREFIX}lambda-role"
FN_NAME="${PREFIX}sse"
OAC_ALWAYS_NAME="${PREFIX}always"
OAC_NOOV_NAME="${PREFIX}nooverride"
AUTHZ_POLICY_NAME="${PREFIX}authz"
DIST_COMMENT="dsh-poc-spike-04 CloudFront + Lambda Function URL SSE"

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

# 按名称查 OAC / 自定义缓存策略 / 分发 ID（state 丢失时也能定位）
oac_id_by_name() {
  aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$1'].Id | [0]" --output text 2>/dev/null | grep -v '^None$' || true
}
cache_policy_id_by_name() {
  aws cloudfront list-cache-policies --type custom \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$1'].CachePolicy.Id | [0]" --output text 2>/dev/null | grep -v '^None$' || true
}
dist_ids_by_comment() {
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' || true
}

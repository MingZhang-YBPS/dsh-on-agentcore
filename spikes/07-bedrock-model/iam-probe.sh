#!/usr/bin/env bash
# 用受限临时角色确定 OpenAI 兼容端点实际需要的 IAM 动作与资源 ARN。
# 依次给角色挂不同的内联策略，假设角色后运行 src/probe-iam.mjs；结束时删除角色。
# 运行目录需已安装依赖（见 README）。结果追加到 results/probe-iam.jsonl。
set -euo pipefail
export AWS_PAGER=""
DIR="$(cd "$(dirname "$0")" && pwd)"
REGION="${1:-us-east-1}"
ROLE="dsh-poc-spike-07-iam-probe"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ME="$(aws sts get-caller-identity --query Arn --output text)"
OUT="$DIR/results/probe-iam.jsonl"; mkdir -p "$DIR/results"; : > "$OUT"
cleanup() {
  for p in $(aws iam list-role-policies --role-name "$ROLE" --query PolicyNames --output text 2>/dev/null); do aws iam delete-role-policy --role-name "$ROLE" --policy-name "$p"; done
  aws iam delete-role --role-name "$ROLE" 2>/dev/null && echo "deleted role $ROLE" || true
}
trap cleanup EXIT
aws iam create-role --role-name "$ROLE" --tags Key=purpose,Value=dsh-poc-spike-07 --max-session-duration 3600 \
  --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"$ME\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
sleep 12

run_with() { # label policy-json-or-empty
  for p in $(aws iam list-role-policies --role-name "$ROLE" --query PolicyNames --output text); do aws iam delete-role-policy --role-name "$ROLE" --policy-name "$p"; done
  [[ -n "$2" ]] && aws iam put-role-policy --role-name "$ROLE" --policy-name probe --policy-document "$2"
  sleep 12 # IAM 最终一致
  local c
  for i in 1 2 3; do c="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/$ROLE" --role-session-name "$1" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)" && break; sleep 5; done
  read -r AK SK ST <<<"$c"
  AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
    node "$DIR/src/probe-iam.mjs" "$1" "$REGION" | tee -a "$OUT"
}
FM="arn:aws:bedrock:$REGION::foundation-model"
run_with none ''
run_with invoke-only "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock:InvokeModel\",\"Resource\":\"$FM/deepseek.v3.2\"}]}"
run_with stream-only "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock:InvokeModelWithResponseStream\",\"Resource\":\"$FM/deepseek.v3.2\"}]}"
run_with runtime-both+mantle-create "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"$FM/deepseek.v3.2\"},{\"Effect\":\"Allow\",\"Action\":\"bedrock-mantle:CreateInference\",\"Resource\":\"*\"}]}"

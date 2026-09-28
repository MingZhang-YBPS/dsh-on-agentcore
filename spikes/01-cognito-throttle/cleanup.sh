#!/usr/bin/env bash
# 删除 Spike 01 创建的全部 AWS 资源。可重复执行；已不存在的资源视为已删除。
# 按资源名（dsh-poc-spike- 前缀）与 .state/state.env 双重定位，state 丢失时也能清理。

source "$(dirname "$0")/common.sh"
load_state
set +e

report() { printf '%-10s %-55s %s\n' "$1" "$2" "$3"; }

# User Pool（连同其中的用户与 App Client 一起删除）
POOL_IDS="${POOL_ID:-}"
POOL_IDS="$POOL_IDS $(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id" --output text 2>/dev/null)"
for p in $(echo "$POOL_IDS" | tr ' \t' '\n' | sort -u | grep -v '^None$'); do
  if aws cognito-idp delete-user-pool --user-pool-id "$p" 2>/dev/null; then
    report DELETED "cognito user pool $p" ""
  else
    aws cognito-idp describe-user-pool --user-pool-id "$p" >/dev/null 2>&1 \
      && report FAILED "cognito user pool $p" "" || report ABSENT "cognito user pool $p" ""
  fi
done

for fn in "$PRE_FN" "$POST_FN"; do
  if aws lambda delete-function --function-name "$fn" >/dev/null 2>&1; then
    report DELETED "lambda $fn" ""
  else
    aws lambda get-function --function-name "$fn" >/dev/null 2>&1 \
      && report FAILED "lambda $fn" "" || report ABSENT "lambda $fn" ""
  fi
  lg="/aws/lambda/$fn"
  if aws logs delete-log-group --log-group-name "$lg" 2>/dev/null; then
    report DELETED "log group $lg" ""
  else
    [[ -n "$(aws logs describe-log-groups --log-group-name-prefix "$lg" --query 'logGroups[].logGroupName' --output text)" ]] \
      && report FAILED "log group $lg" "" || report ABSENT "log group $lg" ""
  fi
done

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null
  if aws iam delete-role --role-name "$ROLE_NAME"; then
    report DELETED "iam role $ROLE_NAME" ""
  else
    report FAILED "iam role $ROLE_NAME" ""
  fi
else
  report ABSENT "iam role $ROLE_NAME" ""
fi

rm -rf "$STATE_DIR"
echo "cleanup done"

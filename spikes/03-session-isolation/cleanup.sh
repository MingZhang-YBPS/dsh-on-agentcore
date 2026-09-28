#!/usr/bin/env bash
# 删除 Spike 03 创建的全部 AWS 资源。可重复执行；已不存在的资源视为已删除。
# 按资源名（dsh-poc-spike-03- 前缀 / dsh_poc_spike_03_probe）与 .state/state.env 双重定位。

source "$(dirname "$0")/common.sh"
load_state
set +e

report() { printf '%-10s %-70s %s\n' "$1" "$2" "$3"; }

# AgentCore Runtime
IDS="${RUNTIME_ID:-} $(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId" --output text 2>/dev/null)"
for id in $(echo "$IDS" | tr ' \t' '\n' | sort -u | grep -v '^None$' | grep -v '^$'); do
  if aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 || break
      sleep 5
    done
    aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 \
      && report FAILED "agentcore runtime $id" "5 分钟内未删除完成" || report DELETED "agentcore runtime $id" ""
  else
    aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 \
      && report FAILED "agentcore runtime $id" "" || report ABSENT "agentcore runtime $id" ""
  fi
done

# Runtime 自动创建的工作负载身份（若删除 Runtime 时未一并删除）
for wi in $(aws bedrock-agentcore-control list-workload-identities \
    --query "workloadIdentities[?starts_with(name, '$RUNTIME_NAME')].name" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$'); do
  aws bedrock-agentcore-control delete-workload-identity --name "$wi" >/dev/null 2>&1 \
    && report DELETED "workload identity $wi" "" || report FAILED "workload identity $wi" ""
done

# Runtime 日志组
for lg in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/ \
    --query "logGroups[?contains(logGroupName, '$RUNTIME_NAME')].logGroupName" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$'); do
  aws logs delete-log-group --log-group-name "$lg" && report DELETED "log group $lg" "" || report FAILED "log group $lg" ""
done

# S3 桶（先清空）
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 rm --only-show-errors --recursive "s3://$BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" && report DELETED "s3 bucket $BUCKET" "" || report FAILED "s3 bucket $BUCKET" ""
else
  report ABSENT "s3 bucket $BUCKET" ""
fi

# DynamoDB 表
if aws dynamodb delete-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  aws dynamodb wait table-not-exists --table-name "$TABLE_NAME"
  report DELETED "dynamodb table $TABLE_NAME" ""
else
  aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1 \
    && report FAILED "dynamodb table $TABLE_NAME" "" || report ABSENT "dynamodb table $TABLE_NAME" ""
fi

# IAM 角色（先删内联策略）
for role in "$EXEC_ROLE_NAME" "$WS_ROLE_NAME" "$GW_ROLE_NAME"; do
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    for p in $(aws iam list-role-policies --role-name "$role" --query PolicyNames --output text | tr '\t' '\n'); do
      aws iam delete-role-policy --role-name "$role" --policy-name "$p"
    done
    aws iam delete-role --role-name "$role" && report DELETED "iam role $role" "" || report FAILED "iam role $role" ""
  else
    report ABSENT "iam role $role" ""
  fi
done

rm -rf "$STATE_DIR" "$BUILD_DIR"
echo "cleanup done"

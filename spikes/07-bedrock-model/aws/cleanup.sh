#!/usr/bin/env bash
# 删除 Spike 07 创建的全部 AWS 资源：Runtime（含 session storage）、工作负载身份、日志组、代码桶、执行角色、IAM 探针角色。可重复执行。
source "$(dirname "$0")/common.sh"
load_state
set +e
report() { printf '%-10s %s\n' "$1" "$2"; }
for id in $(printf '%s\n' "${RUNTIME_ID:-}" $(aws bedrock-agentcore-control list-agent-runtimes \
    --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId" --output text 2>/dev/null) | tr '\t' '\n' | sort -u | grep -v '^None$' | grep -v '^$'); do
  if aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1; then
    for _ in $(seq 1 60); do aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 || break; sleep 5; done
    aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 && report FAILED "runtime $id" || report DELETED "runtime $id"
  else report ABSENT "runtime $id"; fi
done
for wi in $(aws bedrock-agentcore-control list-workload-identities --query "workloadIdentities[?starts_with(name, '$RUNTIME_NAME')].name" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$'); do
  aws bedrock-agentcore-control delete-workload-identity --name "$wi" >/dev/null 2>&1 && report DELETED "workload identity $wi" || report FAILED "workload identity $wi"
done
for lg in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/ \
    --query "logGroups[?contains(logGroupName, '$RUNTIME_NAME')].logGroupName" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$'); do
  aws logs delete-log-group --log-group-name "$lg" && report DELETED "log group $lg" || report FAILED "log group $lg"
done
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 rm --only-show-errors --recursive "s3://$BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" && report DELETED "s3 bucket $BUCKET" || report FAILED "s3 bucket $BUCKET"
else report ABSENT "s3 bucket $BUCKET"; fi
for role in "$EXEC_ROLE_NAME" "${PREFIX}iam-probe"; do
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    for p in $(aws iam list-role-policies --role-name "$role" --query PolicyNames --output text | tr '\t' '\n'); do aws iam delete-role-policy --role-name "$role" --policy-name "$p"; done
    aws iam delete-role --role-name "$role" && report DELETED "iam role $role" || report FAILED "iam role $role"
  else report ABSENT "iam role $role"; fi
done
rm -rf "$STATE_DIR" "$BUILD_DIR"
echo "cleanup done"

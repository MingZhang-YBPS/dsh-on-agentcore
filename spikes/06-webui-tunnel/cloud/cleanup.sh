#!/usr/bin/env bash
# 删除阶段 3 创建的 AWS 资源：CloudFront 分发、两个 CloudFront Function、缓存策略、隧道 Lambda（含 Function URL、
# 角色、日志组）、Cognito 用户池。可重复执行。Runtime/桶/执行角色由随后的 aws/cleanup.sh 删除（它也会删掉 .state/）。
# 分发必须先停用并等待部署完成才能删除，通常需要 5–15 分钟。
source "$(dirname "$0")/../aws/common.sh"
load_state
set +e
report() { printf '%-10s %s\n' "$1" "$2"; }
FN_NAME="${PREFIX}tunnel"; FN_ROLE="${PREFIX}tunnel-role"
CF_FNS=("${PREFIX}ws-rewrite" "${PREFIX}default-rewrite"); CP_NAME="${PREFIX}ws-authz"
POOL_NAME="${PREFIX}pool"
DIST_COMMENT="dsh-poc-spike-06 official DSH web UI on AgentCore"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---- CloudFront 分发：停用 → 等待 → 删除 ----
for id in $(printf '%s\n' "${DIST_ID:-}" $(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id" --output text 2>/dev/null) \
    | tr '\t' '\n' | sort -u | grep -v '^None$' | grep -v '^$'); do
  if ! aws cloudfront get-distribution-config --id "$id" --output json > "$TMP/d.json" 2>/dev/null; then report ABSENT "distribution $id"; continue; fi
  if [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["DistributionConfig"]["Enabled"])' "$TMP/d.json")" == True ]]; then
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d["DistributionConfig"]; c["Enabled"]=False; json.dump(c, open(sys.argv[2],"w"))' "$TMP/d.json" "$TMP/c.json"
    aws cloudfront update-distribution --id "$id" --if-match "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$TMP/d.json")" \
      --distribution-config "file://$TMP/c.json" >/dev/null || { report FAILED "distribution $id (disable)"; continue; }
    echo "   distribution $id 已停用，等待部署完成…"
  fi
  aws cloudfront wait distribution-deployed --id "$id"
  ETAG="$(aws cloudfront get-distribution --id "$id" --query ETag --output text)"
  aws cloudfront delete-distribution --id "$id" --if-match "$ETAG" && report DELETED "distribution $id" || report FAILED "distribution $id"
done

# ---- CloudFront Functions 与缓存策略（分发删除后才能删）----
for n in "${CF_FNS[@]}"; do
  if ETAG="$(aws cloudfront describe-function --name "$n" --query ETag --output text 2>/dev/null)"; then
    aws cloudfront delete-function --name "$n" --if-match "$ETAG" && report DELETED "cloudfront function $n" || report FAILED "cloudfront function $n"
  else report ABSENT "cloudfront function $n"; fi
done
CP_ID="$(aws cloudfront list-cache-policies --type custom --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$CP_NAME'].CachePolicy.Id | [0]" --output text 2>/dev/null)"
if [[ -n "$CP_ID" && "$CP_ID" != None ]]; then
  ETAG="$(aws cloudfront get-cache-policy --id "$CP_ID" --query ETag --output text)"
  aws cloudfront delete-cache-policy --id "$CP_ID" --if-match "$ETAG" && report DELETED "cache policy $CP_NAME" || report FAILED "cache policy $CP_NAME"
else report ABSENT "cache policy $CP_NAME"; fi

# ---- 隧道 Lambda ----
if aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1; then
  aws lambda delete-function-url-config --function-name "$FN_NAME" >/dev/null 2>&1
  aws lambda delete-function --function-name "$FN_NAME" >/dev/null && report DELETED "lambda $FN_NAME" || report FAILED "lambda $FN_NAME"
else report ABSENT "lambda $FN_NAME"; fi
if aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/$FN_NAME" --query 'logGroups[0].logGroupName' --output text 2>/dev/null | grep -q "$FN_NAME"; then
  aws logs delete-log-group --log-group-name "/aws/lambda/$FN_NAME" && report DELETED "log group /aws/lambda/$FN_NAME" || report FAILED "log group /aws/lambda/$FN_NAME"
else report ABSENT "log group /aws/lambda/$FN_NAME"; fi
if aws iam get-role --role-name "$FN_ROLE" >/dev/null 2>&1; then
  for p in $(aws iam list-role-policies --role-name "$FN_ROLE" --query PolicyNames --output text | tr '\t' '\n'); do aws iam delete-role-policy --role-name "$FN_ROLE" --policy-name "$p"; done
  for a in $(aws iam list-attached-role-policies --role-name "$FN_ROLE" --query 'AttachedPolicies[].PolicyArn' --output text | tr '\t' '\n'); do aws iam detach-role-policy --role-name "$FN_ROLE" --policy-arn "$a"; done
  aws iam delete-role --role-name "$FN_ROLE" && report DELETED "iam role $FN_ROLE" || report FAILED "iam role $FN_ROLE"
else report ABSENT "iam role $FN_ROLE"; fi

# ---- Cognito ----
for pid in $(printf '%s\n' "${POOL_ID:-}" $(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id" --output text 2>/dev/null) \
    | tr '\t' '\n' | sort -u | grep -v '^None$' | grep -v '^$'); do
  if aws cognito-idp describe-user-pool --user-pool-id "$pid" >/dev/null 2>&1; then
    aws cognito-idp delete-user-pool --user-pool-id "$pid" && report DELETED "cognito pool $pid" || report FAILED "cognito pool $pid"
  else report ABSENT "cognito pool $pid"; fi
done
rm -f "$STATE_DIR/cloud-secrets.env" "$STATE_DIR/dist.json" "$STATE_DIR/dist-new.json" "$STATE_DIR/fn.err"
echo "cloud cleanup done（接着执行 aws/cleanup.sh 删除 Runtime、桶与执行角色）"

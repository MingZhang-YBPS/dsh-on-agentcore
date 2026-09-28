#!/usr/bin/env bash
# 删除 Spike 04 创建的全部 AWS 资源。可重复执行；已不存在的资源视为已删除。
# CloudFront 分发必须先禁用并等待部署完成才能删除，这一步通常需要 5–15 分钟。

source "$(dirname "$0")/common.sh"
load_state
set +e

report() { printf '%-10s %-70s %s\n' "$1" "$2" "$3"; }

# CloudFront 分发：禁用 → 等待 → 删除
for id in $(printf '%s\n' "${DIST_ID:-}" $(dist_ids_by_comment) | sort -u | grep -v '^$'); do
  if ! aws cloudfront get-distribution --id "$id" >/dev/null 2>&1; then
    report ABSENT "cloudfront distribution $id" ""
    continue
  fi
  mkdir -p "$STATE_DIR"
  aws cloudfront get-distribution-config --id "$id" --output json > "$STATE_DIR/dist.json"
  enabled="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["DistributionConfig"]["Enabled"])' "$STATE_DIR/dist.json")"
  if [[ "$enabled" == "True" ]]; then
    etag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$STATE_DIR/dist.json")"
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["DistributionConfig"]; d["Enabled"]=False; print(json.dumps(d))' \
      "$STATE_DIR/dist.json" > "$STATE_DIR/dist-disabled.json"
    aws cloudfront update-distribution --id "$id" --if-match "$etag" \
      --distribution-config "file://$STATE_DIR/dist-disabled.json" >/dev/null
    echo "   已禁用 $id，等待部署完成"
  fi
  aws cloudfront wait distribution-deployed --id "$id"
  etag="$(aws cloudfront get-distribution --id "$id" --query ETag --output text)"
  if aws cloudfront delete-distribution --id "$id" --if-match "$etag"; then
    report DELETED "cloudfront distribution $id" ""
  else
    report FAILED "cloudfront distribution $id" "可稍后重跑 cleanup.sh"
  fi
done

# 缓存策略与 OAC（分发删除后才能删）
cp_id="${AUTHZ_CACHE_POLICY:-$(cache_policy_id_by_name "$AUTHZ_POLICY_NAME")}"
if [[ -n "$cp_id" ]] && etag="$(aws cloudfront get-cache-policy --id "$cp_id" --query ETag --output text 2>/dev/null)"; then
  aws cloudfront delete-cache-policy --id "$cp_id" --if-match "$etag" \
    && report DELETED "cache policy $cp_id" "" || report FAILED "cache policy $cp_id" ""
else
  report ABSENT "cache policy $AUTHZ_POLICY_NAME" ""
fi
for name in "$OAC_ALWAYS_NAME" "$OAC_NOOV_NAME"; do
  oid="$(oac_id_by_name "$name")"
  if [[ -n "$oid" ]]; then
    etag="$(aws cloudfront get-origin-access-control --id "$oid" --query ETag --output text)"
    aws cloudfront delete-origin-access-control --id "$oid" --if-match "$etag" \
      && report DELETED "origin access control $name ($oid)" "" || report FAILED "origin access control $name" ""
  else
    report ABSENT "origin access control $name" ""
  fi
done

# Lambda 函数（连同 Function URL 与资源策略）及日志组
if aws lambda delete-function --function-name "$FN_NAME" 2>/dev/null; then
  report DELETED "lambda $FN_NAME" ""
else
  aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1 \
    && report FAILED "lambda $FN_NAME" "" || report ABSENT "lambda $FN_NAME" ""
fi
lg="/aws/lambda/$FN_NAME"
if aws logs delete-log-group --log-group-name "$lg" 2>/dev/null; then
  report DELETED "log group $lg" ""
else
  report ABSENT "log group $lg" ""
fi

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null
  aws iam delete-role --role-name "$ROLE_NAME" && report DELETED "iam role $ROLE_NAME" "" || report FAILED "iam role $ROLE_NAME" ""
else
  report ABSENT "iam role $ROLE_NAME" ""
fi

rm -rf "$STATE_DIR" "$BUILD_DIR"
echo "cleanup done"

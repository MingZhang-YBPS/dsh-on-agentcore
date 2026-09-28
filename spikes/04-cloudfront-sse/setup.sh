#!/usr/bin/env bash
# 创建 Spike 04 的全部 AWS 资源。可重复执行：已存在的资源复用。
# CloudFront 分发首次部署通常需要 5–15 分钟。

source "$(dirname "$0")/common.sh"
load_state
cd "$SPIKE_DIR"

[[ -z "${SETUP_STARTED_MS:-}" ]] && save_state SETUP_STARTED_MS "$(now_ms)"
save_state REGION "$REGION"
save_state ACCOUNT_ID "$ACCOUNT_ID"
save_state FN_NAME "$FN_NAME"

echo "== 1/7 依赖"
npm ci --no-audit --no-fund --loglevel=error

echo "== 2/7 Lambda 执行角色 $ROLE_NAME"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags Key=purpose,Value=dsh-poc-spike-04 >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
fi

echo "== 3/7 Lambda 函数 $FN_NAME（nodejs22.x / arm64 / RESPONSE_STREAM）"
mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR/fn.zip"
(cd src/lambda && zip -q -X "$BUILD_DIR/fn.zip" index.mjs)
if aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_NAME" --zip-file "fileb://$BUILD_DIR/fn.zip" >/dev/null
else
  # 新建角色后 IAM 传播需要若干秒
  for i in $(seq 1 12); do
    if aws lambda create-function --function-name "$FN_NAME" --runtime nodejs22.x --architectures arm64 \
        --handler index.handler --role "$ROLE_ARN" --timeout 300 --memory-size 256 \
        --zip-file "fileb://$BUILD_DIR/fn.zip" --tags purpose=dsh-poc-spike-04 >/dev/null 2>"$STATE_DIR/fn.err"; then
      break
    fi
    grep -q 'cannot be assumed' "$STATE_DIR/fn.err" || { cat "$STATE_DIR/fn.err" >&2; exit 1; }
    echo "   执行角色尚未传播（$i/12），5 秒后重试"
    [[ $i == 12 ]] && exit 1
    sleep 5
  done
fi
aws lambda wait function-active-v2 --function-name "$FN_NAME"
aws lambda wait function-updated-v2 --function-name "$FN_NAME"

if ! aws lambda get-function-url-config --function-name "$FN_NAME" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FN_NAME" \
    --auth-type AWS_IAM --invoke-mode RESPONSE_STREAM >/dev/null
fi
FN_URL="$(aws lambda get-function-url-config --function-name "$FN_NAME" --query FunctionUrl --output text)"
FN_DOMAIN="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$FN_URL")"
save_state FN_URL "$FN_URL"
save_state FN_DOMAIN "$FN_DOMAIN"
echo "   $FN_URL"

echo "== 4/7 OAC（always / no-override）"
ensure_oac() { # name signing-behavior
  local id
  id="$(oac_id_by_name "$1")"
  if [[ -z "$id" ]]; then
    id="$(aws cloudfront create-origin-access-control --origin-access-control-config \
      "Name=$1,Description=dsh-poc-spike-04,SigningProtocol=sigv4,SigningBehavior=$2,OriginAccessControlOriginType=lambda" \
      --query OriginAccessControl.Id --output text)"
  fi
  echo "$id"
}
OAC_ALWAYS="$(ensure_oac "$OAC_ALWAYS_NAME" always)"
OAC_NOOV="$(ensure_oac "$OAC_NOOV_NAME" no-override)"
save_state OAC_ALWAYS "$OAC_ALWAYS"
save_state OAC_NOOV "$OAC_NOOV"

echo "== 5/7 缓存策略 $AUTHZ_POLICY_NAME"
AUTHZ_CACHE_POLICY="$(cache_policy_id_by_name "$AUTHZ_POLICY_NAME")"
if [[ -z "$AUTHZ_CACHE_POLICY" ]]; then
  AUTHZ_CACHE_POLICY="$(aws cloudfront create-cache-policy \
    --cache-policy-config "$(node src/cf-config.mjs authz-policy)" --query CachePolicy.Id --output text)"
fi
save_state AUTHZ_CACHE_POLICY "$AUTHZ_CACHE_POLICY"

echo "== 6/7 CloudFront 分发"
DIST_ID="$(dist_ids_by_comment | head -1)"
if [[ -z "$DIST_ID" ]]; then
  export FN_DOMAIN OAC_ALWAYS OAC_NOOV AUTHZ_CACHE_POLICY
  export CALLER_REF="dsh-poc-spike-04-$(now_ms)"
  CFG="$(node src/cf-config.mjs distribution)"
  DIST_ID="$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags \
    "{\"DistributionConfig\":$CFG,\"Tags\":{\"Items\":[{\"Key\":\"purpose\",\"Value\":\"dsh-poc-spike-04\"}]}}" \
    --query Distribution.Id --output text)"
fi
DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
save_state DIST_ID "$DIST_ID"
save_state DIST_DOMAIN "$DIST_DOMAIN"
echo "   $DIST_ID https://$DIST_DOMAIN"

echo "== 7/7 授权 CloudFront 调用函数（lambda:InvokeFunctionUrl + lambda:InvokeFunction）"
for pair in "AllowCloudFrontInvokeFunctionUrl:lambda:InvokeFunctionUrl" "AllowCloudFrontInvokeFunction:lambda:InvokeFunction"; do
  sid="${pair%%:*}"; action="${pair#*:}"
  aws lambda add-permission --function-name "$FN_NAME" --statement-id "$sid" --action "$action" \
    --principal cloudfront.amazonaws.com --source-arn "$DIST_ARN" >/dev/null 2>"$STATE_DIR/perm.err" \
    || grep -q 'ResourceConflictException' "$STATE_DIR/perm.err" || { cat "$STATE_DIR/perm.err" >&2; exit 1; }
done

echo "   等待分发部署完成（通常 5–15 分钟）"
aws cloudfront wait distribution-deployed --id "$DIST_ID"
echo "setup done"

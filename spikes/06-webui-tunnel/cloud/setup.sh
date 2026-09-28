#!/usr/bin/env bash
# 阶段 3：Cognito（两名测试用户）+ Runtime 切换为 JWT 授权 + 隧道 Lambda + CloudFront（默认行为 → Lambda，/api/remote.mux → AgentCore /ws）。
# 前置：aws/build.sh、aws/setup.sh 已执行（Runtime 存在）。可重复执行。
# 测试用户口令随机生成，只写入 .state/cloud-secrets.env（0600，gitignored），不打印。
source "$(dirname "$0")/../aws/common.sh"
load_state
CLOUD_DIR="$SPIKE_DIR/cloud"
SECRETS="$STATE_DIR/cloud-secrets.env"
[[ -f "$SECRETS" ]] && source "$SECRETS"
POOL_NAME="${PREFIX}pool"; CLIENT_NAME="${PREFIX}client"
FN_NAME="${PREFIX}tunnel"; FN_ROLE="${PREFIX}tunnel-role"
CF_FN_NAME="${PREFIX}ws-rewrite"; CF_DEF_FN_NAME="${PREFIX}default-rewrite"; CP_NAME="${PREFIX}ws-authz"
DIST_COMMENT="dsh-poc-spike-06 official DSH web UI on AgentCore"
rand() { python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("Aa1!"+"".join(secrets.choice(a) for _ in range(20)))'; }

echo "== 1/6 Cognito"
POOL_ID="${POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)}"
if [[ -z "$POOL_ID" || "$POOL_ID" == None ]]; then
  POOL_ID="$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" --username-configuration CaseSensitive=false \
    --user-pool-tags purpose=dsh-poc-spike-06 --query UserPool.Id --output text)"
fi
CLIENT_ID="${CLIENT_ID:-$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text)}"
if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == None ]]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name "$CLIENT_NAME" --no-generate-secret \
    --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH --prevent-user-existence-errors ENABLED \
    --query UserPoolClient.ClientId --output text)"
fi
# 令牌有效期（Spike 09 用 5 分钟观察过期行为）：每次执行都按 TOKEN_VALIDITY_MINUTES 更新 App Client（默认 60）
TVM="${TOKEN_VALIDITY_MINUTES:-60}"
aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --client-name "$CLIENT_NAME" \
  --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH --prevent-user-existence-errors ENABLED \
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days \
  --access-token-validity "$TVM" --id-token-validity "$TVM" --refresh-token-validity 1 >/dev/null
save_state POOL_ID "$POOL_ID"; save_state CLIENT_ID "$CLIENT_ID"
touch "$SECRETS"; chmod 600 "$SECRETS"
for u in alice bob; do
  var="PASS_${u^^}"
  if [[ -z "${!var:-}" ]]; then printf '%s=%q\n' "$var" "$(rand)" >> "$SECRETS"; source "$SECRETS"; fi
  aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$u" >/dev/null 2>&1 || \
    aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$u" --message-action SUPPRESS >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$u" --password "${!var}" --permanent
  save_state "SUB_${u^^}" "$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$u" --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)"
done

echo "== 2/6 Runtime 切换为 JWT 授权（allowedClients=$CLIENT_ID）并放行 Authorization 头"
ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$CODE_KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"app.js\"]}}"
ENVV="{\"MOCK_MODEL\":\"1\",\"MODEL_ID\":\"us.deepseek.r1-v1:0\",\"MODEL_REGION\":\"$REGION\",\"USER_HOME\":\"$MOUNT_PATH\",\"DSH_PATCHES\":\"dsh/web.cordis.yml,dsh/web-hardening.cordis.yml\",\"REQUIRE_SESSION_OWNER\":\"1\"}"
AUTHZ="{\"customJWTAuthorizer\":{\"discoveryUrl\":\"https://cognito-idp.$REGION.amazonaws.com/$POOL_ID/.well-known/openid-configuration\",\"allowedClients\":[\"$CLIENT_ID\"]}}"
# 约 60 MB 的上传偶发 EOF / 空闲超时失败（Spike 09 实测两次）：重试 4 次
for i in 1 2 3 4; do aws s3 cp --only-show-errors "$BUILD_DIR/adapter.zip" "s3://$BUCKET/$CODE_KEY" && break; [[ $i == 4 ]] && exit 1; sleep 5; done
aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" --network-configuration networkMode=PUBLIC \
  --environment-variables "$ENVV" --filesystem-configurations "[{\"sessionStorage\":{\"mountPath\":\"$MOUNT_PATH\"}}]" \
  --lifecycle-configuration "idleRuntimeSessionTimeout=${IDLE_TIMEOUT:-900},maxLifetime=${MAX_LIFETIME:-3600}" \
  --authorizer-configuration "$AUTHZ" --request-header-configuration 'requestHeaderAllowlist=Authorization' >/dev/null
for _ in $(seq 1 120); do
  STATUS="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query status --output text)"
  case "$STATUS" in READY) break ;; *FAILED) aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --output json >&2; exit 1 ;; esac
  sleep 5
done
save_state RUNTIME_VERSION "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeVersion --output text)"

echo "== 3/6 隧道 Lambda $FN_NAME"
ORIGIN_SECRET="${ORIGIN_SECRET:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')}"
grep -q '^ORIGIN_SECRET=' "$SECRETS" || printf 'ORIGIN_SECRET=%q\n' "$ORIGIN_SECRET" >> "$SECRETS"
FN_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${FN_ROLE}"
if ! aws iam get-role --role-name "$FN_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$FN_ROLE" --tags Key=purpose,Value=dsh-poc-spike-06 \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$FN_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi
aws iam put-role-policy --role-name "$FN_ROLE" --policy-name cognito --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"cognito-idp:AdminInitiateAuth\",\"Resource\":\"arn:aws:cognito-idp:$REGION:$ACCOUNT_ID:userpool/$POOL_ID\"}]}"
mkdir -p "$BUILD_DIR"; rm -f "$BUILD_DIR/tunnel.zip"
(cd "$CLOUD_DIR/lambda" && zip -q -X "$BUILD_DIR/tunnel.zip" index.mjs)
FN_ENV="Variables={RUNTIME_ARN=$RUNTIME_ARN,USER_POOL_ID=$POOL_ID,CLIENT_ID=$CLIENT_ID,ORIGIN_SECRET=$ORIGIN_SECRET}"
if aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_NAME" --zip-file "fileb://$BUILD_DIR/tunnel.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN_NAME"
  aws lambda update-function-configuration --function-name "$FN_NAME" --environment "$FN_ENV" >/dev/null
else
  for i in $(seq 1 12); do
    aws lambda create-function --function-name "$FN_NAME" --runtime nodejs22.x --architectures arm64 --handler index.handler \
      --role "$FN_ROLE_ARN" --timeout 900 --memory-size 512 --zip-file "fileb://$BUILD_DIR/tunnel.zip" --environment "$FN_ENV" \
      --tags purpose=dsh-poc-spike-06 >/dev/null 2>"$STATE_DIR/fn.err" && break
    grep -q 'cannot be assumed' "$STATE_DIR/fn.err" || { cat "$STATE_DIR/fn.err" >&2; exit 1; }
    sleep 5
  done
fi
aws lambda wait function-updated-v2 --function-name "$FN_NAME"
if ! aws lambda get-function-url-config --function-name "$FN_NAME" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FN_NAME" --auth-type NONE --invoke-mode RESPONSE_STREAM >/dev/null
  aws lambda add-permission --function-name "$FN_NAME" --statement-id PublicUrl --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FN_NAME" --statement-id PublicUrlInvoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null
fi
FN_URL="$(aws lambda get-function-url-config --function-name "$FN_NAME" --query FunctionUrl --output text)"
FN_DOMAIN="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$FN_URL")"
save_state FN_URL "$FN_URL"; save_state FN_DOMAIN "$FN_DOMAIN"

echo "== 4/6 CloudFront Functions（$CF_FN_NAME：/api/remote.mux → AgentCore /ws；$CF_DEF_FN_NAME：以 ? 开头的查询串搬进头）"
ENC_ARN="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$RUNTIME_ARN")"
sed "s|__ENCODED_RUNTIME_ARN__|$ENC_ARN|" "$CLOUD_DIR/cf-ws-function.js" > "$BUILD_DIR/cf-ws-function.js"
cp "$CLOUD_DIR/cf-default-function.js" "$BUILD_DIR/cf-default-function.js"
publish_fn() { # name code-file
  local etag
  if etag="$(aws cloudfront describe-function --name "$1" --query ETag --output text 2>/dev/null)"; then
    etag="$(aws cloudfront update-function --name "$1" --if-match "$etag" --function-config Comment=spike06,Runtime=cloudfront-js-2.0 \
      --function-code "fileb://$2" --query ETag --output text)"
  else
    etag="$(aws cloudfront create-function --name "$1" --function-config Comment=spike06,Runtime=cloudfront-js-2.0 \
      --function-code "fileb://$2" --query ETag --output text)"
  fi
  aws cloudfront publish-function --name "$1" --if-match "$etag" >/dev/null
  aws cloudfront describe-function --name "$1" --stage LIVE --query FunctionSummary.FunctionMetadata.FunctionARN --output text
}
CF_FN_ARN="$(publish_fn "$CF_FN_NAME" "$BUILD_DIR/cf-ws-function.js")"
CF_DEF_FN_ARN="$(publish_fn "$CF_DEF_FN_NAME" "$BUILD_DIR/cf-default-function.js")"
save_state CF_FN_ARN "$CF_FN_ARN"; save_state CF_DEF_FN_ARN "$CF_DEF_FN_ARN"

echo "== 5/6 缓存策略 $CP_NAME（Authorization 与查询串进缓存键，才会被转发到 AgentCore）"
CP_ID="$(aws cloudfront list-cache-policies --type custom --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$CP_NAME'].CachePolicy.Id | [0]" --output text)"
if [[ -z "$CP_ID" || "$CP_ID" == None ]]; then
  CP_ID="$(aws cloudfront create-cache-policy --cache-policy-config "{\"Name\":\"$CP_NAME\",\"DefaultTTL\":0,\"MaxTTL\":1,\"MinTTL\":0,
    \"ParametersInCacheKeyAndForwardedToOrigin\":{\"EnableAcceptEncodingGzip\":false,\"EnableAcceptEncodingBrotli\":false,
    \"HeadersConfig\":{\"HeaderBehavior\":\"whitelist\",\"Headers\":{\"Quantity\":1,\"Items\":[\"Authorization\"]}},
    \"CookiesConfig\":{\"CookieBehavior\":\"none\"},\"QueryStringsConfig\":{\"QueryStringBehavior\":\"all\"}}}" --query CachePolicy.Id --output text)"
fi
save_state CP_ID "$CP_ID"

echo "== 6/6 CloudFront 分发"
DIST_ID="${DIST_ID:-$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" --output text 2>/dev/null)}"
if [[ -z "$DIST_ID" || "$DIST_ID" == None ]]; then
  CFG=$(python3 - "$FN_DOMAIN" "$ORIGIN_SECRET" "$REGION" "$CP_ID" "$CF_FN_ARN" "$DIST_COMMENT" "$CF_DEF_FN_ARN" <<'EOF'
import json, sys, time
fn, secret, region, cp, fnarn, comment, deffn = sys.argv[1:]
CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'
ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac'
def origin(i, dom, headers):
    return {'Id': i, 'DomainName': dom, 'OriginPath': '',
            'CustomHeaders': {'Quantity': len(headers), 'Items': [{'HeaderName': k, 'HeaderValue': v} for k, v in headers]},
            'CustomOriginConfig': {'HTTPPort': 80, 'HTTPSPort': 443, 'OriginProtocolPolicy': 'https-only',
                                   'OriginSslProtocols': {'Quantity': 1, 'Items': ['TLSv1.2']}, 'OriginReadTimeout': 60, 'OriginKeepaliveTimeout': 5},
            'ConnectionAttempts': 3, 'ConnectionTimeout': 10, 'OriginShield': {'Enabled': False}, 'OriginAccessControlId': ''}
def behavior(target, cpid, methods, fn_assoc=None, path=None):
    b = {'TargetOriginId': target, 'ViewerProtocolPolicy': 'redirect-to-https',
         'AllowedMethods': {'Quantity': len(methods), 'Items': methods, 'CachedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD']}},
         'CachePolicyId': cpid, 'OriginRequestPolicyId': ALL_VIEWER_EXCEPT_HOST, 'Compress': False,
         'FunctionAssociations': {'Quantity': 1 if fn_assoc else 0, **({'Items': [{'EventType': 'viewer-request', 'FunctionARN': fn_assoc}]} if fn_assoc else {})},
         'LambdaFunctionAssociations': {'Quantity': 0}, 'SmoothStreaming': False, 'FieldLevelEncryptionId': '',
         'TrustedSigners': {'Enabled': False, 'Quantity': 0}, 'TrustedKeyGroups': {'Enabled': False, 'Quantity': 0}}
    if path: b['PathPattern'] = path
    return b
all7 = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE']
cfg = {'CallerReference': f'spike06-{int(time.time())}', 'Comment': comment, 'Enabled': True, 'PriceClass': 'PriceClass_100',
       'HttpVersion': 'http2', 'IsIPV6Enabled': True,
       'Origins': {'Quantity': 2, 'Items': [origin('tunnel', fn, [('X-Origin-Verify', secret)]),
                                            origin('agentcore', f'bedrock-agentcore.{region}.amazonaws.com', [])]},
       'DefaultCacheBehavior': behavior('tunnel', CACHING_DISABLED, all7, deffn),
       'CacheBehaviors': {'Quantity': 1, 'Items': [behavior('agentcore', cp, ['GET', 'HEAD'], fnarn, '/api/remote.mux')]}}
print(json.dumps({'DistributionConfig': cfg, 'Tags': {'Items': [{'Key': 'purpose', 'Value': 'dsh-poc-spike-06'}]}}))
EOF
)
  DIST_ID="$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags "$CFG" --query Distribution.Id --output text)"
else
  # 已有分发：确保默认行为挂上 $CF_DEF_FN_NAME
  aws cloudfront get-distribution-config --id "$DIST_ID" --output json > "$STATE_DIR/dist.json"
  if python3 - "$STATE_DIR/dist.json" "$CF_DEF_FN_ARN" "$STATE_DIR/dist-new.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1])); cfg = d['DistributionConfig']; arn = sys.argv[2]
fa = cfg['DefaultCacheBehavior'].get('FunctionAssociations', {'Quantity': 0})
if any(i['FunctionARN'] == arn for i in fa.get('Items', [])): sys.exit(1)
cfg['DefaultCacheBehavior']['FunctionAssociations'] = {'Quantity': 1, 'Items': [{'EventType': 'viewer-request', 'FunctionARN': arn}]}
json.dump(cfg, open(sys.argv[3], 'w'))
PYEOF
  then
    aws cloudfront update-distribution --id "$DIST_ID" --if-match "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$STATE_DIR/dist.json")" \
      --distribution-config "file://$STATE_DIR/dist-new.json" >/dev/null
  fi
fi
DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
save_state DIST_ID "$DIST_ID"; save_state DIST_DOMAIN "$DIST_DOMAIN"
echo "   等待分发部署（通常 5–15 分钟）：https://$DIST_DOMAIN"
aws cloudfront wait distribution-deployed --id "$DIST_ID"
echo "cloud setup done: https://$DIST_DOMAIN"

#!/usr/bin/env bash
# 阶段 2：创建代码桶、执行角色与 AgentCore Runtime（NODE_22 直接代码部署 + 托管 session storage）。
# 先运行 aws/build.sh 生成 $BUILD_DIR/adapter.zip。可重复执行：已存在的资源复用，Runtime 会被更新到新代码包。
source "$(dirname "$0")/common.sh"
load_state
[[ -f "$BUILD_DIR/adapter.zip" ]] || { echo "先运行 aws/build.sh" >&2; exit 1; }
[[ -z "${SETUP_STARTED_MS:-}" ]] && save_state SETUP_STARTED_MS "$(now_ms)"
save_state REGION "$REGION"; save_state BUCKET "$BUCKET"

echo "== 1/3 代码桶 $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  if [[ "$REGION" == us-east-1 ]]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=purpose,Value=dsh-poc-spike-06}]'
fi
aws s3 cp --only-show-errors "$BUILD_DIR/adapter.zip" "s3://$BUCKET/$CODE_KEY"

echo "== 2/3 执行角色 $EXEC_ROLE_NAME"
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT_ID"},"ArnLike":{"aws:SourceArn":"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:*"}}}]}
EOF
)
POLICY=$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"Logs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams","logs:DescribeLogGroups"],
  "Resource":["arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:*"]},
 {"Sid":"CodePackage","Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::$BUCKET/code/*"},
 {"Sid":"WorkloadToken","Effect":"Allow","Action":["bedrock-agentcore:GetWorkloadAccessToken","bedrock-agentcore:GetWorkloadAccessTokenForJWT","bedrock-agentcore:GetWorkloadAccessTokenForUserId"],
  "Resource":["arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default","arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default/workload-identity/*"]}
]}
EOF
)
if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$EXEC_ROLE_NAME" --assume-role-policy-document "$TRUST" --tags Key=purpose,Value=dsh-poc-spike-06 >/dev/null
  NEW_ROLE=1
fi
aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name runtime --policy-document "$POLICY"
save_state EXEC_ROLE_ARN "$EXEC_ROLE_ARN"
[[ "${NEW_ROLE:-0}" == 1 ]] && sleep 10

echo "== 3/3 AgentCore Runtime $RUNTIME_NAME"
ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$CODE_KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"app.js\"]}}"
ENVV="{\"MOCK_MODEL\":\"1\",\"MODEL_ID\":\"us.deepseek.r1-v1:0\",\"MODEL_REGION\":\"$REGION\",\"USER_HOME\":\"$MOUNT_PATH\",\"DSH_PATCHES\":\"dsh/web.cordis.yml,dsh/web-hardening.cordis.yml\"}"
FS="[{\"sessionStorage\":{\"mountPath\":\"$MOUNT_PATH\"}}]"
LIFE="idleRuntimeSessionTimeout=${IDLE_TIMEOUT:-900},maxLifetime=${MAX_LIFETIME:-3600}"
RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text)"
if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == None ]]; then
  for i in $(seq 1 8); do
    if RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime --agent-runtime-name "$RUNTIME_NAME" \
        --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" --network-configuration networkMode=PUBLIC \
        --environment-variables "$ENVV" --filesystem-configurations "$FS" --lifecycle-configuration "$LIFE" \
        --tags purpose=dsh-poc-spike-06 --query agentRuntimeId --output text 2>"$STATE_DIR/create.err")"; then break; fi
    echo "   create 失败（$i/8）：$(head -c 400 "$STATE_DIR/create.err")"
    [[ $i == 8 ]] && exit 1
    sleep 10
  done
else
  aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" --network-configuration networkMode=PUBLIC \
    --environment-variables "$ENVV" --filesystem-configurations "$FS" --lifecycle-configuration "$LIFE" >/dev/null
fi
save_state RUNTIME_ID "$RUNTIME_ID"
for _ in $(seq 1 120); do
  STATUS="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query status --output text)"
  case "$STATUS" in READY) break ;; *FAILED) aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --output json >&2; exit 1 ;; esac
  sleep 5
done
[[ "$STATUS" == READY ]] || { echo "Runtime 未就绪：$STATUS" >&2; exit 1; }
RUNTIME_ARN="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
VERSION="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeVersion --output text)"
save_state RUNTIME_ARN "$RUNTIME_ARN"
save_state RUNTIME_VERSION "$VERSION"
echo "   $RUNTIME_ARN READY (version $VERSION)"

#!/usr/bin/env bash
# 构建代码包（复用 Spike 06 的 aws/build.sh）→ 代码桶 → 最小权限执行角色 → AgentCore Runtime（IAM 授权，session storage）。
# 执行角色只有：日志、读取代码包、工作负载令牌，以及两个端点面上所选 DeepSeek 模型的调用权限（Spike 07 探针确定的动作与资源）。
# 用法：aws/setup.sh [surface] [model]，默认 bedrock-runtime deepseek.v3.2。可重复执行。
source "$(dirname "$0")/common.sh"
load_state
SURFACE="${1:-bedrock-runtime}"; MODEL="${2:-deepseek.v3.2}"

echo "== 1/4 构建代码包（$BUILD_DIR）"
SPIKE06_BUILD_DIR="$BUILD_DIR" bash "$S06_DIR/aws/build.sh"

echo "== 2/4 代码桶 $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  if [[ "$REGION" == us-east-1 ]]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=purpose,Value=$TAG}]"
fi
aws s3 cp --only-show-errors "$BUILD_DIR/adapter.zip" "s3://$BUCKET/$CODE_KEY"
save_state REGION "$REGION"; save_state BUCKET "$BUCKET"

echo "== 3/4 执行角色 $EXEC_ROLE_NAME"
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
TRUST="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"bedrock-agentcore.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",
 \"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT_ID\"},\"ArnLike\":{\"aws:SourceArn\":\"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:*\"}}}]}"
# 模型权限：bedrock-runtime 端点面只需要 bedrock:InvokeModel（流式也一样；只给 InvokeModelWithResponseStream 会被拒绝），
# 资源为基础模型 ARN；bedrock-mantle 端点面需要 bedrock-mantle:CreateInference，资源为 project/default。
POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[
 {\"Sid\":\"Logs\",\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"logs:DescribeLogGroups\"],
  \"Resource\":[\"arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:*\"]},
 {\"Sid\":\"CodePackage\",\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/code/*\"},
 {\"Sid\":\"WorkloadToken\",\"Effect\":\"Allow\",\"Action\":[\"bedrock-agentcore:GetWorkloadAccessToken\",\"bedrock-agentcore:GetWorkloadAccessTokenForJWT\",\"bedrock-agentcore:GetWorkloadAccessTokenForUserId\"],
  \"Resource\":[\"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default\",\"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default/workload-identity/*\"]},
 {\"Sid\":\"ModelRuntimeSurface\",\"Effect\":\"Allow\",\"Action\":\"bedrock:InvokeModel\",
  \"Resource\":[\"arn:aws:bedrock:$REGION::foundation-model/deepseek.v3.2\"]},
 {\"Sid\":\"ModelMantleSurface\",\"Effect\":\"Allow\",\"Action\":\"bedrock-mantle:CreateInference\",
  \"Resource\":[\"arn:aws:bedrock-mantle:$REGION:$ACCOUNT_ID:project/default\"]}
]}"
if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$EXEC_ROLE_NAME" --assume-role-policy-document "$TRUST" --tags Key=purpose,Value=$TAG >/dev/null
  NEW_ROLE=1
fi
aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name runtime --policy-document "$POLICY"
save_state EXEC_ROLE_ARN "$EXEC_ROLE_ARN"
[[ "${NEW_ROLE:-0}" == 1 ]] && sleep 10

echo "== 4/4 AgentCore Runtime $RUNTIME_NAME（$SURFACE / $MODEL）"
ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$CODE_KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"app.js\"]}}"
FS="[{\"sessionStorage\":{\"mountPath\":\"$MOUNT_PATH\"}}]"
LIFE="idleRuntimeSessionTimeout=900,maxLifetime=3600"
RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text)"
if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == None ]]; then
  ENVV="$(bash "$AWS_DIR/configure.sh" --print-env "$SURFACE" "$MODEL")"
  for i in $(seq 1 8); do
    if RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime --agent-runtime-name "$RUNTIME_NAME" \
        --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" --network-configuration networkMode=PUBLIC \
        --environment-variables "$ENVV" --filesystem-configurations "$FS" --lifecycle-configuration "$LIFE" \
        --tags purpose=$TAG --query agentRuntimeId --output text 2>"$STATE_DIR/create.err")"; then break; fi
    echo "   create 失败（$i/8）：$(head -c 400 "$STATE_DIR/create.err")"
    [[ $i == 8 ]] && exit 1
    sleep 10
  done
  save_state RUNTIME_ID "$RUNTIME_ID"
  wait_ready "$RUNTIME_ID"
  save_state RUNTIME_ARN "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
  save_state MODEL_SURFACE "$SURFACE"; save_state MODEL_ID "$MODEL"
else
  save_state RUNTIME_ID "$RUNTIME_ID"
  bash "$AWS_DIR/configure.sh" "$SURFACE" "$MODEL"
fi
load_state
echo "   $RUNTIME_ARN READY"

#!/usr/bin/env bash
# 创建 Spike 03 的全部 AWS 资源并播种数据。可重复执行：已存在的资源复用，策略与种子数据每次重写。

source "$(dirname "$0")/common.sh"
load_state
cd "$SPIKE_DIR"

CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
[[ -z "${SETUP_STARTED_MS:-}" ]] && save_state SETUP_STARTED_MS "$(now_ms)"
save_state REGION "$REGION"
save_state ACCOUNT_ID "$ACCOUNT_ID"
save_state BUCKET "$BUCKET"
save_state TABLE_NAME "$TABLE_NAME"
save_state CALLER_ARN "$CALLER_ARN"

EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
GW_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${GW_ROLE_NAME}"
WS_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${WS_ROLE_NAME}"
export ACCOUNT_ID REGION BUCKET CALLER_ARN EXEC_ROLE_ARN GW_ROLE_ARN WS_ROLE_ARN

echo "== 1/6 构建探针包"
npm ci --no-audit --no-fund --loglevel=error
mkdir -p "$BUILD_DIR"
npx esbuild src/probe/app.mjs --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$BUILD_DIR/app.js" --log-level=warning
chmod 644 "$BUILD_DIR/app.js"
# 本机试跑时避免被上层 package.json 的 "type": "module" 当成 ESM；zip 里只放 app.js（无 package.json 即按 CommonJS）
printf '{"type":"commonjs"}\n' > "$BUILD_DIR/package.json"
rm -f "$BUILD_DIR/probe.zip"
(cd "$BUILD_DIR" && zip -q -X probe.zip app.js)

echo "== 2/6 S3 桶 $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=purpose,Value=dsh-poc-spike-03}]'
fi
aws s3 cp --only-show-errors "$BUILD_DIR/probe.zip" "s3://$BUCKET/$CODE_KEY"

echo "== 3/6 DynamoDB 表 $TABLE_NAME"
if ! aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST --tags Key=purpose,Value=dsh-poc-spike-03 >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME"
fi
TABLE_ARN="$(aws dynamodb describe-table --table-name "$TABLE_NAME" --query Table.TableArn --output text)"
export TABLE_ARN
save_state TABLE_ARN "$TABLE_ARN"

echo "== 4/6 IAM 角色"
ensure_role() { # name trust-policy-name
  local name="$1" doc i
  doc="$(node src/policies.mjs "$2")"
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$name" --policy-document "$doc"
    return
  fi
  # 信任策略引用刚创建的角色时，IAM 传播前会报 MalformedPolicyDocument: Invalid principal，重试
  for i in $(seq 1 12); do
    if aws iam create-role --role-name "$name" --assume-role-policy-document "$doc" \
        --tags Key=purpose,Value=dsh-poc-spike-03 >/dev/null 2>"$STATE_DIR/role.err"; then
      return
    fi
    grep -q 'Invalid principal' "$STATE_DIR/role.err" || { cat "$STATE_DIR/role.err" >&2; exit 1; }
    echo "   $name：principal 尚未传播（$i/12），5 秒后重试"
    sleep 5
  done
  cat "$STATE_DIR/role.err" >&2
  exit 1
}
put_policy() { # role-name policy-name
  aws iam put-role-policy --role-name "$1" --policy-name "$2" --policy-document "$(node src/policies.mjs "$2")"
}
ensure_role "$GW_ROLE_NAME" gw-trust          # 工作空间角色的信任策略引用它，必须先存在
ensure_role "$WS_ROLE_NAME" ws-trust
ensure_role "$EXEC_ROLE_NAME" exec-trust
put_policy "$GW_ROLE_NAME" gw-policy
put_policy "$WS_ROLE_NAME" ws-policy
put_policy "$EXEC_ROLE_NAME" exec-policy
save_state EXEC_ROLE_ARN "$EXEC_ROLE_ARN"
save_state GW_ROLE_ARN "$GW_ROLE_ARN"
save_state WS_ROLE_ARN "$WS_ROLE_ARN"

echo "== 5/6 播种会话 A / B"
SESSION_A="${SESSION_A:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
SESSION_B="${SESSION_B:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
save_state SESSION_A "$SESSION_A"
save_state SESSION_B "$SESSION_B"
# 清掉上一轮留下的对象，保证 P01/P02 从干净状态开始
aws s3 rm --only-show-errors --recursive "s3://$BUCKET/workspaces/"
for sid in "$SESSION_A" "$SESSION_B"; do
  printf 'seed-of-%s' "$sid" | aws s3 cp --only-show-errors - "s3://$BUCKET/workspaces/$sid/seed.txt"
  aws dynamodb put-item --table-name "$TABLE_NAME" \
    --item "{\"PK\":{\"S\":\"WORKSPACE#$sid\"},\"SK\":{\"S\":\"HEAD\"},\"version\":{\"N\":\"1\"}}"
  aws dynamodb put-item --table-name "$TABLE_NAME" \
    --item "{\"PK\":{\"S\":\"SESSION#$sid\"},\"SK\":{\"S\":\"RUNCTL\"},\"state\":{\"S\":\"idle\"}}"
done
echo "   A=$SESSION_A"
echo "   B=$SESSION_B"

echo "== 6/6 AgentCore Runtime $RUNTIME_NAME"
ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$CODE_KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"app.js\"]}}"
RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text)"
if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == "None" ]]; then
  # 新建角色后 IAM 传播需要若干秒；CreateAgentRuntime 会校验执行角色可被扮演
  for i in 1 2 3 4 5 6 7 8; do
    if RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime \
        --agent-runtime-name "$RUNTIME_NAME" \
        --agent-runtime-artifact "$ARTIFACT" \
        --role-arn "$EXEC_ROLE_ARN" \
        --network-configuration networkMode=PUBLIC \
        --lifecycle-configuration idleRuntimeSessionTimeout=120,maxLifetime=900 \
        --tags purpose=dsh-poc-spike-03 \
        --query agentRuntimeId --output text 2>"$STATE_DIR/create.err")"; then
      break
    fi
    echo "   create 失败（$i/8）：$(head -c 300 "$STATE_DIR/create.err")"
    [[ $i == 8 ]] && exit 1
    sleep 10
  done
else
  aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" \
    --network-configuration networkMode=PUBLIC \
    --lifecycle-configuration idleRuntimeSessionTimeout=120,maxLifetime=900 >/dev/null
fi
save_state RUNTIME_ID "$RUNTIME_ID"

for i in $(seq 1 120); do
  STATUS="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query status --output text)"
  case "$STATUS" in
    READY) break ;;
    *FAILED)
      aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --output json >&2
      exit 1 ;;
  esac
  sleep 5
done
[[ "$STATUS" == "READY" ]] || { echo "Runtime 10 分钟内未就绪：$STATUS" >&2; exit 1; }
RUNTIME_ARN="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
save_state RUNTIME_ARN "$RUNTIME_ARN"
echo "   $RUNTIME_ARN READY"
echo "setup done"

#!/usr/bin/env bash
# 创建 Spike 01 所需的临时资源：IAM 角色、两个触发器 Lambda、User Pool、App Client。
# 资源名统一带 dsh-poc-spike- 前缀；资源标识写入 .state/state.env，供 cleanup.sh 删除。
# 可重复执行：已存在的资源会被复用。

source "$(dirname "$0")/common.sh"
load_state

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
save_state ACCOUNT_ID "$ACCOUNT_ID"
save_state REGION "$REGION"
echo "Account=$ACCOUNT_ID Region=$REGION"

# ---- IAM 角色 ----
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags Key=purpose,Value=dsh-poc-spike-01 >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "created role $ROLE_NAME (waiting for IAM propagation)"
  sleep 12
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"
save_state ROLE_ARN "$ROLE_ARN"

# ---- Lambda 触发器 ----
ZIP="$STATE_DIR/trigger.zip"
mkdir -p "$STATE_DIR"
(cd "$SPIKE_DIR/lambda" && zip -q -j "$ZIP" trigger.mjs)

create_fn() { # name env
  local name="$1" env="$2"
  if aws lambda get-function --function-name "$name" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$name" --zip-file "fileb://$ZIP" >/dev/null
    aws lambda wait function-updated --function-name "$name"
    aws lambda update-function-configuration --function-name "$name" --environment "$env" >/dev/null
  else
    local i created=0
    for i in 1 2 3 4 5 6; do
      if aws lambda create-function --function-name "$name" --runtime nodejs22.x \
        --handler trigger.handler --role "$ROLE_ARN" --zip-file "fileb://$ZIP" \
        --timeout 5 --memory-size 128 --environment "$env" \
        --tags purpose=dsh-poc-spike-01 >/dev/null 2>"$STATE_DIR/create-fn.err"; then
        created=1
        break
      fi
      echo "create-function $name retry $i: $(tr -d '\n' < "$STATE_DIR/create-fn.err")" >&2
      sleep 5
    done
    if [[ $created -ne 1 ]]; then echo "ERROR: create-function $name failed" >&2; exit 1; fi
  fi
  aws lambda wait function-active-v2 --function-name "$name"
  aws lambda get-function --function-name "$name" --query Configuration.FunctionArn --output text
}

PRE_ARN="$(create_fn "$PRE_FN" "{\"Variables\":{\"LOCKED_USERS\":\"$USER_LOCKED\"}}")"
POST_ARN="$(create_fn "$POST_FN" '{"Variables":{"LOCKED_USERS":""}}')"
save_state PRE_ARN "$PRE_ARN"
save_state POST_ARN "$POST_ARN"
echo "lambda: $PRE_ARN / $POST_ARN"

# ---- User Pool ----
if [[ -z "${POOL_ID:-}" ]] || ! aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" >/dev/null 2>&1; then
  POOL_ID="$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" \
    --lambda-config "PreAuthentication=$PRE_ARN,PostAuthentication=$POST_ARN" \
    --admin-create-user-config AllowAdminCreateUserOnly=true \
    --user-pool-tags purpose=dsh-poc-spike-01 \
    --query UserPool.Id --output text)"
  echo "created user pool $POOL_ID"
fi
save_state POOL_ID "$POOL_ID"
POOL_ARN="arn:aws:cognito-idp:$REGION:$ACCOUNT_ID:userpool/$POOL_ID"

for fn in "$PRE_FN" "$POST_FN"; do
  aws lambda add-permission --function-name "$fn" --statement-id cognito-invoke \
    --action lambda:InvokeFunction --principal cognito-idp.amazonaws.com \
    --source-arn "$POOL_ARN" >/dev/null 2>&1 || true
done

# ---- App Client：公共客户端（无 secret），开启 PreventUserExistenceErrors ----
if [[ -z "${CLIENT_ID:-}" ]] || ! aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" >/dev/null 2>&1; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --access-token-validity 12 --id-token-validity 12 \
    --token-validity-units AccessToken=hours,IdToken=hours \
    --query UserPoolClient.ClientId --output text)"
  echo "created app client $CLIENT_ID"
fi
save_state CLIENT_ID "$CLIENT_ID"

echo "setup done. state: $STATE_FILE"

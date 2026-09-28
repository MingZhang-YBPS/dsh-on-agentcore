#!/usr/bin/env bash
# 切换 Runtime 的模型配置（端点面 + 模型标识），代码包不变。每次切换产生一个新的 Runtime 版本。
#   aws/configure.sh <surface> <model>             更新 Runtime 并等待 READY
#   aws/configure.sh --print-env <surface> <model>  只输出环境变量 JSON（供 setup.sh 创建时使用）
source "$(dirname "$0")/common.sh"
load_state
PRINT=0; [[ "${1:-}" == --print-env ]] && { PRINT=1; shift; }
SURFACE="$1"; MODEL="$2"
BASE="$(surface_base "$SURFACE")"; SERVICE="$(surface_service "$SURFACE")"
[[ -z "$BASE" ]] && { echo "未知端点面：$SURFACE" >&2; exit 1; }
ENVV="{\"MODEL_ID\":\"$MODEL\",\"MODEL_REGION\":\"$REGION\",\"MODEL_BASE_URL\":\"$BASE\",\"MODEL_SIGNING_SERVICE\":\"$SERVICE\",\"USER_HOME\":\"$MOUNT_PATH\",\"DSH_PATCHES\":\"dsh/web.cordis.yml,dsh/web-hardening.cordis.yml\"}"
if [[ $PRINT == 1 ]]; then echo "$ENVV"; exit 0; fi
ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$CODE_KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"app.js\"]}}"
aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --agent-runtime-artifact "$ARTIFACT" --role-arn "$EXEC_ROLE_ARN" --network-configuration networkMode=PUBLIC \
  --environment-variables "$ENVV" --filesystem-configurations "[{\"sessionStorage\":{\"mountPath\":\"$MOUNT_PATH\"}}]" \
  --lifecycle-configuration idleRuntimeSessionTimeout=900,maxLifetime=3600 >/dev/null
sleep 3
wait_ready "$RUNTIME_ID"
save_state RUNTIME_ARN "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
save_state RUNTIME_VERSION "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeVersion --output text)"
save_state MODEL_SURFACE "$SURFACE"; save_state MODEL_ID "$MODEL"
echo "   Runtime 已切换到 $SURFACE / $MODEL（version $(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeVersion --output text)）"

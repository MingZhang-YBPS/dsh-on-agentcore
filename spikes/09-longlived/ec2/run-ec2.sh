#!/usr/bin/env bash
# 在 us-east-1 默认 VPC 启动一台 t4g.micro（AL2023 arm64），用 user-data 安装 Node 与 ws，运行 ws-probe.mjs，
# 把结果上传到 Spike 06 的代码桶 results/ 前缀，然后关机（instance-initiated shutdown = terminate）。
# 本脚本负责：创建 4 个探针用户并取令牌、创建临时实例角色、启动实例、等待结果、下载结果、删除角色。
# 用法：ec2/run-ec2.sh [minutes]（默认 75）
set -euo pipefail
export AWS_PAGER=""
DIR="$(cd "$(dirname "$0")/.." && pwd)"
S06="$DIR/../06-webui-tunnel"
source "$S06/.state/state.env"
MIN="${1:-75}"
ROLE="dsh-poc-spike-09-ec2"
KEY="results/ws-probe-$(date +%s).json"
pw() { python3 -c 'import secrets; print("Aa1!"+secrets.token_hex(10))'; }

users="["
for n in v1 v2 v3 v4; do
  u="ec2-$n"; p="$(pw)"
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$u" --message-action SUPPRESS >/dev/null 2>&1 || true
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$u" --password "$p" --permanent
  tok="$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$u,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text)"
  sub="$(python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["sub"])' "$tok")"
  label="$(echo $n | tr a-z A-Z)"
  users+="{\"label\":\"$label\",\"tok\":\"$tok\",\"sid\":\"dsh-user-$sub\"},"
done
users="${users%,}]"
CONFIG="{\"region\":\"$REGION\",\"runtimeArn\":\"$RUNTIME_ARN\",\"dist\":\"$DIST_DOMAIN\",\"minutes\":$MIN,\"users\":$users}"

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --tags Key=purpose,Value=dsh-poc-spike-09 \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name put-results --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/results/*\"}]}"
sleep 12
AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
PROBE_B64="$(base64 -w0 "$DIR/ec2/ws-probe.mjs")"
CONFIG_B64="$(printf '%s' "$CONFIG" | base64 -w0)"
USERDATA="$(cat <<EOF
#!/bin/bash
set -x
dnf install -y nodejs npm >/var/log/probe-install.log 2>&1
mkdir -p /opt/probe && cd /opt/probe
echo '{"type":"module","dependencies":{"ws":"8.21.3"}}' > package.json
npm install --no-audit --no-fund >>/var/log/probe-install.log 2>&1
echo $PROBE_B64 | base64 -d > ws-probe.mjs
CONFIG="\$(echo $CONFIG_B64 | base64 -d)" OUT=/opt/probe/out.json node ws-probe.mjs > /var/log/probe.log 2>&1
aws s3 cp /opt/probe/out.json s3://$BUCKET/$KEY || aws s3 cp /var/log/probe.log s3://$BUCKET/$KEY
shutdown -h now
EOF
)"
IID="$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.micro --iam-instance-profile Name="$ROLE" \
  --instance-initiated-shutdown-behavior terminate --user-data "$USERDATA" \
  --metadata-options HttpTokens=required \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=purpose,Value=dsh-poc-spike-09},{Key=Name,Value=dsh-poc-spike-09-ws-probe}]' \
  --query 'Instances[0].InstanceId' --output text)"
echo "instance $IID; result s3://$BUCKET/$KEY after ~$((MIN + 5)) min"
echo "$IID $KEY" > "$DIR/.ec2-probe"

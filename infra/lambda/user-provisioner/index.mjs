// 自定义资源（cr.Provider 的 onEvent）：创建 Cognito 用户并把 Secrets Manager 里的口令设为永久口令。
// CloudFormation 的 secretsmanager 动态引用不能用在自定义资源属性里，所以口令由这里在运行时读取，不经过模板。
// 属性：UserPoolId、Username、SecretArn。删除时删除用户（用户已不存在则忽略）。

import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

const cognito = new CognitoIdentityProviderClient({})
const sm = new SecretsManagerClient({})

export async function handler(event) {
  const { UserPoolId, Username, SecretArn } = event.ResourceProperties
  const physicalId = `${UserPoolId}/${Username}`
  if (event.RequestType === 'Delete') {
    // 物理 ID 变化（换了用户池或用户名）时 CloudFormation 会删除旧资源：按旧物理 ID 删除
    const [pool, user] = event.PhysicalResourceId.split('/')
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: user }))
    } catch (e) {
      if (e.name !== 'UserNotFoundException' && e.name !== 'ResourceNotFoundException') throw e
    }
    return { PhysicalResourceId: event.PhysicalResourceId }
  }
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId, Username, MessageAction: 'SUPPRESS' }))
  } catch (e) {
    if (e.name !== 'UsernameExistsException') throw e
  }
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SecretArn }))
  if (!SecretString) throw new Error(`secret ${SecretArn} has no string value`)
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username, Password: SecretString, Permanent: true }))
  return { PhysicalResourceId: physicalId }
}

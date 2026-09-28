// Lambda 入口（Node.js 22，Function URL，InvokeMode=RESPONSE_STREAM）：提供 ports.ts 的 AWS 实现并接到 handler.ts。
// 环境变量：RUNTIME_ARN USER_POOL_ID CLIENT_ID ORIGIN_SECRET THROTTLE_TABLE REFRESH_TOKEN_VALIDITY_DAYS TOKEN_REFRESH_SKEW_SECONDS LOG_LEVEL

import { AdminInitiateAuthCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createLogger } from '@dsh-poc/log'
import { EMPTY_STATE } from '@dsh-poc/auth-throttle'
import { handle, type Deps, type FunctionUrlEvent } from './handler.js'
import { AuthFailed, type AuthPort, type OpenResponse, type RuntimePort, type ThrottleStore } from './ports.js'

// Lambda Node.js 运行时注入的全局对象（响应流）
declare const awslambda: {
  streamifyResponse(fn: (event: FunctionUrlEvent, stream: NodeJS.WritableStream) => Promise<void>): unknown
  HttpResponseStream: { from(stream: NodeJS.WritableStream, meta: { statusCode: number; headers?: Record<string, string>; cookies?: string[] }): NodeJS.WritableStream }
}

const env = process.env
const region = env.AWS_REGION ?? 'us-east-1'
const cognito = new CognitoIdentityProviderClient({ region })
const ddb = new DynamoDBClient({ region })
const AUTH_FAILURES = new Set(['NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException', 'PasswordResetRequiredException', 'InvalidParameterException'])

export const cognitoAuth = (userPoolId: string, clientId: string): AuthPort => ({
  async login(username, password) {
    try {
      const r = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } }))
      const a = r.AuthenticationResult
      if (!a?.AccessToken) throw new AuthFailed('challenge required')
      return { accessToken: a.AccessToken, expiresIn: a.ExpiresIn ?? 3600, ...(a.RefreshToken ? { refreshToken: a.RefreshToken } : {}) }
    } catch (e) { if (e instanceof AuthFailed || AUTH_FAILURES.has((e as Error).name)) throw new AuthFailed(); throw e }
  },
  async refresh(refreshToken, username) {
    try {
      const r = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refreshToken, USERNAME: username } }))
      const a = r.AuthenticationResult
      if (!a?.AccessToken) throw new AuthFailed()
      return { accessToken: a.AccessToken, expiresIn: a.ExpiresIn ?? 3600 }
    } catch (e) { if (e instanceof AuthFailed || AUTH_FAILURES.has((e as Error).name)) throw new AuthFailed(); throw e }
  },
  async globalSignOut(username) {
    await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }))
  },
})

export const dynamoThrottle = (table: string): ThrottleStore => ({
  async get(key) {
    const r = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: key } }, ConsistentRead: true }))
    const it = r.Item
    if (!it) return { state: EMPTY_STATE, version: 0 }
    return {
      state: { failures: (it.failures?.L ?? []).map((x) => Number(x.N)), lockedUntil: it.lockedUntil?.N ? Number(it.lockedUntil.N) : null },
      version: Number(it.version?.N ?? '0'),
    }
  },
  async put(key, state, expectedVersion, ttl) {
    try {
      await ddb.send(new PutItemCommand({
        TableName: table,
        Item: {
          pk: { S: key }, failures: { L: state.failures.map((n) => ({ N: String(n) })) }, version: { N: String(expectedVersion + 1) }, ttl: { N: String(ttl) },
          ...(state.lockedUntil !== null ? { lockedUntil: { N: String(state.lockedUntil) } } : {}),
        },
        ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(pk)' : 'version = :v',
        ...(expectedVersion === 0 ? {} : { ExpressionAttributeValues: { ':v': { N: String(expectedVersion) } } }),
      }))
      return true
    } catch (e) { if (e instanceof ConditionalCheckFailedException) return false; throw e }
  },
})

export const agentcoreRuntime = (runtimeArn: string, rgn: string): RuntimePort => {
  const url = `https://bedrock-agentcore.${rgn}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=DEFAULT`
  return {
    async invoke(payload, sessionId, accessToken) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/octet-stream', 'x-amzn-bedrock-agentcore-runtime-session-id': sessionId },
        body: payload,
      })
      return { status: r.status, body: r.body as unknown as AsyncIterable<Uint8Array> | null, text: () => r.text() }
    },
  }
}

function required(name: string): string {
  const v = env[name]
  if (!v) throw new Error(`missing environment variable ${name}`)
  return v
}

let deps: Deps | null = null
function getDeps(): Deps {
  deps ??= {
    cfg: {
      originSecret: required('ORIGIN_SECRET'),
      refreshTokenMaxAgeSeconds: Number(env.REFRESH_TOKEN_VALIDITY_DAYS ?? '1') * 86_400,
      refreshSkewSeconds: Number(env.TOKEN_REFRESH_SKEW_SECONDS ?? '300'),
    },
    auth: cognitoAuth(required('USER_POOL_ID'), required('CLIENT_ID')),
    throttle: dynamoThrottle(required('THROTTLE_TABLE')),
    runtime: agentcoreRuntime(required('RUNTIME_ARN'), region),
    clock: { now: () => Date.now() },
    log: createLogger({ minLevel: (env.LOG_LEVEL as 'info' | undefined) ?? 'info', base: {} }),
  }
  return deps
}

// 注意：AWS SDK 依赖的 @aws/lambda-invoke-store 在 Lambda 之外也会创建 globalThis.awslambda = {}，所以按函数是否存在判断
const inLambda = typeof awslambda !== 'undefined' && typeof awslambda.streamifyResponse === 'function'
export const handler = !inLambda ? undefined : awslambda.streamifyResponse(async (event, stream) => {
  const d = getDeps()
  let opened = false
  const open: OpenResponse = (status, headers, cookies = []) => {
    if (opened) throw new Error('response already opened')
    opened = true
    const s = awslambda.HttpResponseStream.from(stream, { statusCode: status, headers, cookies: [...cookies] })
    return { write: (c) => { s.write(typeof c === 'string' ? c : Buffer.from(c)) }, end: () => s.end() }
  }
  await handle(event, open, { ...d, log: (level, msg, fields) => d.log(level, msg, { requestId: event.requestContext.requestId, ...fields }) })
})

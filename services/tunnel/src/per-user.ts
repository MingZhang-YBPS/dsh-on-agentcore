// 每用户 Runtime 部署（DshPerUser 栈）的隧道 Lambda 入口。路由与业务逻辑与 index.ts 完全相同（handler.ts），区别：
//   1. RuntimePort 按访问令牌的 username 从路由表（DynamoDB，pk = USER#<用户名>，runtimeId）查出该用户的 Runtime，结果缓存在内存里；
//   2. 下发 dsh_rt cookie（该用户的 Runtime ID，Path=/api/remote.mux），供 CloudFront Function ws-rewrite-per-user 拼出 WebSocket 的目标 ARN。
//      CloudFront Function 不能访问 DynamoDB，所以由这里把路由结果交给浏览器。Runtime ID 不是秘密：cookie 被改成别人的 ID 时，
//      对方 Runtime 的 JWT 授权器会因 username 声明不符而拒绝；ws-rewrite-per-user 还会核对 ID 的名称部分与令牌 username 一致。
// 单独成一个入口而不修改 index.ts / handler.ts：DshPoc 栈的隧道代码包保持字节不变。
// 环境变量：RUNTIME_ARN_PREFIX（arn:…:runtime/）ROUTE_TABLE ROUTE_CACHE_MS（默认 60000）
//          USER_POOL_ID CLIENT_ID ORIGIN_SECRET THROTTLE_TABLE REFRESH_TOKEN_VALIDITY_DAYS TOKEN_REFRESH_SKEW_SECONDS LOG_LEVEL

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createHash, timingSafeEqual } from 'node:crypto'
import { encodeResponseHead } from '@dsh-poc/envelope'
import { createLogger } from '@dsh-poc/log'
import { jwtPayload } from '@dsh-poc/session-identity'
import { ACCESS_COOKIE, parseCookies } from './cookies.js'
import { handle, type Deps, type FunctionUrlEvent } from './handler.js'
import { cognitoAuth, dynamoThrottle } from './index.js'
import type { OpenResponse, RuntimePort } from './ports.js'

declare const awslambda: {
  streamifyResponse(fn: (event: FunctionUrlEvent, stream: NodeJS.WritableStream) => Promise<void>): unknown
  HttpResponseStream: { from(stream: NodeJS.WritableStream, meta: { statusCode: number; headers?: Record<string, string>; cookies?: string[] }): NodeJS.WritableStream }
}

const env = process.env
const region = env.AWS_REGION ?? 'us-east-1'

export const ROUTE_COOKIE = 'dsh_rt'
/** 只发给 WebSocket 行为；ws-rewrite-per-user 读取后连同其他 cookie 一起删掉，不会到达 AgentCore */
export const ROUTE_COOKIE_PATH = '/api/remote.mux'
/** Runtime ID = dsh_pu_<名称>-<10 位后缀>（与 infra/lib/params.ts 的 userRuntimeName 一致） */
export const RUNTIME_ID_RE = /^dsh_pu_[A-Za-z0-9_]{1,41}-[A-Za-z0-9]{10}$/
export const NO_RUNTIME_MESSAGE = 'no runtime is provisioned for this user'
export const routeKey = (username: string): string => `USER#${username}`

/** 用户名 → Runtime ID（没有 Runtime 时为 null） */
export interface RouteLookup { runtimeIdOf(username: string): Promise<string | null> }

/** DynamoDB 路由表 + 内存缓存（命中与未命中都缓存 cacheMs；增删用户后最多 cacheMs 生效） */
export function dynamoRoutes(table: string, cacheMs: number, get: (key: string) => Promise<string | null> = dynamoGet(table), now: () => number = Date.now): RouteLookup {
  const cache = new Map<string, { id: string | null; at: number }>()
  return {
    async runtimeIdOf(username) {
      const hit = cache.get(username)
      if (hit && now() - hit.at < cacheMs) return hit.id
      const raw = await get(routeKey(username))
      const id = raw !== null && RUNTIME_ID_RE.test(raw) ? raw : null
      cache.set(username, { id, at: now() })
      return id
    },
  }
}

function dynamoGet(table: string): (key: string) => Promise<string | null> {
  const ddb = new DynamoDBClient({ region })
  return async (key) => {
    const r = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: key } }, ProjectionExpression: 'runtimeId' }))
    return r.Item?.runtimeId?.S ?? null
  }
}

/** 一个已封包的响应（handler 会原样解包转发），用来在不调用 AgentCore 的情况下返回明确的错误 */
function envelopedReply(status: number, message: string): Awaited<ReturnType<RuntimePort['invoke']>> {
  const wire = Buffer.concat([encodeResponseHead({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }), Buffer.from(message)])
  return { status: 200, body: (async function* () { yield wire })(), text: async () => '' }
}

/** 与部署参数 demoUsers 的校验一致；不合规的 username 不去查表 */
const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/
const usernameOf = (token: string | undefined): string | undefined => {
  const u = token ? jwtPayload(token)?.username : undefined
  return typeof u === 'string' && USERNAME_RE.test(u) ? u : undefined
}

const originOk = (given: string | undefined, expected: string): boolean =>
  !!given && !!expected && timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest())

/**
 * 按令牌 username 选择 Runtime。令牌在这里只解码不验签：目标 Runtime 的 JWT 授权器会验签，
 * 并要求 username 声明等于该 Runtime 的所属用户，所以伪造 username 的令牌到不了别人的 Runtime。
 * 没有 Runtime 的用户（例如 ops）得到 403，不调用 AgentCore。
 */
export function perUserRuntime(arnPrefix: string, routes: RouteLookup, rgn: string, fetchImpl: typeof fetch = fetch): RuntimePort {
  return {
    async invoke(payload, sessionId, accessToken) {
      const username = usernameOf(accessToken)
      const id = username ? await routes.runtimeIdOf(username) : null
      if (!id) return envelopedReply(403, NO_RUNTIME_MESSAGE)
      const url = `https://bedrock-agentcore.${rgn}.amazonaws.com/runtimes/${encodeURIComponent(`${arnPrefix}${id}`)}/invocations?qualifier=DEFAULT`
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/octet-stream', 'x-amzn-bedrock-agentcore-runtime-session-id': sessionId },
        body: payload,
      })
      return { status: r.status, body: r.body as unknown as AsyncIterable<Uint8Array> | null, text: () => r.text() }
    },
  }
}

export const routeCookie = (runtimeId: string, maxAgeSeconds: number): string =>
  `${ROUTE_COOKIE}=${runtimeId}; Path=${ROUTE_COOKIE_PATH}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`
export const CLEAR_ROUTE_COOKIE = `${ROUTE_COOKIE}=; Path=${ROUTE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const isPageNavigation = (ev: FunctionUrlEvent) => ev.requestContext.http.method === 'GET' && (ev.rawPath === '/' || ev.rawPath === '/index.html')

/**
 * 在 handler 的响应上附加 dsh_rt cookie：
 *   - /auth/logout：清除；
 *   - /auth/*、/plugins/*（共享缓存，绝不能带 Set-Cookie）：不动；
 *   - 其他请求：令牌有 username 且查得到 Runtime 时，页面导航总是下发（刷新页面即可修复过期的 cookie），
 *     其余请求只在浏览器带来的 dsh_rt 缺失或不一致时下发。
 */
export async function handleWithRoute(ev: FunctionUrlEvent, open: OpenResponse, d: Deps, routes: RouteLookup): Promise<void> {
  const path = ev.rawPath
  let extra: string | null = null
  // 绕过 CloudFront 的直连请求由 handler 返回 403；这里先挡住，避免为它们查表
  if (!originOk(ev.headers?.['x-origin-verify'], d.cfg.originSecret)) { await handle(ev, open, d); return }
  if (path === '/auth/logout') extra = CLEAR_ROUTE_COOKIE
  else if (!path.startsWith('/auth/') && !path.startsWith('/plugins/')) {
    const cookies = parseCookies(ev.cookies)
    const username = usernameOf(cookies.get(ACCESS_COOKIE))
    const id = username ? await routes.runtimeIdOf(username).catch((e: Error) => { d.log('warn', 'route lookup failed', { error: e.message }); return null }) : null
    if (id && (isPageNavigation(ev) || cookies.get(ROUTE_COOKIE) !== id)) extra = routeCookie(id, d.cfg.refreshTokenMaxAgeSeconds)
  }
  const wrapped: OpenResponse = extra === null ? open : (status, headers, cookies = []) => open(status, headers, [...cookies, extra])
  await handle(ev, wrapped, d)
}

function required(name: string): string {
  const v = env[name]
  if (!v) throw new Error(`missing environment variable ${name}`)
  return v
}

let deps: (Deps & { routes: RouteLookup }) | null = null
function getDeps(): Deps & { routes: RouteLookup } {
  if (deps) return deps
  const routes = dynamoRoutes(required('ROUTE_TABLE'), Number(env.ROUTE_CACHE_MS ?? '60000'))
  deps = {
    cfg: {
      originSecret: required('ORIGIN_SECRET'),
      refreshTokenMaxAgeSeconds: Number(env.REFRESH_TOKEN_VALIDITY_DAYS ?? '1') * 86_400,
      refreshSkewSeconds: Number(env.TOKEN_REFRESH_SKEW_SECONDS ?? '300'),
    },
    auth: cognitoAuth(required('USER_POOL_ID'), required('CLIENT_ID')),
    throttle: dynamoThrottle(required('THROTTLE_TABLE')),
    runtime: perUserRuntime(required('RUNTIME_ARN_PREFIX'), routes, region),
    routes,
    clock: { now: () => Date.now() },
    log: createLogger({ minLevel: (env.LOG_LEVEL as 'info' | undefined) ?? 'info', base: {} }),
  }
  return deps
}

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
  const log: Deps['log'] = (level, msg, fields) => d.log(level, msg, { requestId: event.requestContext.requestId, ...fields })
  await handleWithRoute(event, open, { ...d, log }, d.routes)
})

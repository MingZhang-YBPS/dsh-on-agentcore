// CloudFront Function（cloudfront-js-2.0，viewer-request），每用户 Runtime 部署（DshPerUser 栈）挂在 /api/remote.mux 行为上。
// 与 ws-rewrite.js 相同，只是目标 Runtime 取自 dsh_rt cookie（隧道 Lambda 按路由表下发的该用户 Runtime ID）：
//   - 从 HttpOnly cookie dsh_token 取 Cognito 访问令牌，放进 Authorization: Bearer（由该用户 Runtime 的 JWT 授权器验签，
//     授权器还要求 username 声明等于该 Runtime 的所属用户）
//   - dsh_rt 必须形如 dsh_pu_<令牌 username，- 换成 _>-<10 位>：cookie 被改动时最多指向同名的 Runtime，
//     指向别人的 Runtime 会在这里被拒绝（即使漏过，对方的授权器也会拒绝）
//   - runtimeSessionId = dsh-user-<令牌 sub>
//   - URI 改为 /runtimes/<URL 编码的 Runtime ARN>/ws；dsh_rt 缺失或不符时返回 403（刷新页面即可重新下发）
// 这里只解码令牌、不验签。下面的 ARN 前缀占位符（arn:…:runtime/）在部署时替换。

var RUNTIME_ARN_PREFIX = '__RUNTIME_ARN_PREFIX__'

// cloudfront-js-2.0 提供 Buffer；逐字符手工解码会超出函数指令上限（实测 RangeError: Instruction limit exceeded）
function b64urlDecode(s) {
  var b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return Buffer.from(b64, 'base64').toString('utf8')
}

function reject(status, desc) {
  return { statusCode: status, statusDescription: desc, headers: { 'content-type': { value: 'text/plain' } } }
}

function handler(event) {
  var req = event.request
  var c = req.cookies && req.cookies['dsh_token']
  if (!c || !c.value) return reject(401, 'Unauthorized')
  var token = c.value
  var parts = token.split('.')
  if (parts.length !== 3) return reject(401, 'Unauthorized')
  var claims
  try { claims = JSON.parse(b64urlDecode(parts[1])) } catch (e) { return reject(401, 'Unauthorized') }
  var sub = claims && claims.sub
  var username = claims && claims.username
  if (!sub || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sub)) return reject(401, 'Unauthorized')
  if (typeof username !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(username)) return reject(403, 'Forbidden')
  var rt = req.cookies['dsh_rt'] && req.cookies['dsh_rt'].value
  var name = 'dsh_pu_' + username.replace(/-/g, '_') + '-'
  if (!rt || rt.indexOf(name) !== 0 || !/^[A-Za-z0-9]{10}$/.test(rt.slice(name.length))) return reject(403, 'Forbidden')
  req.headers['authorization'] = { value: 'Bearer ' + token }
  delete req.headers['origin']
  delete req.headers['cookie']
  req.cookies = {}
  req.uri = '/runtimes/' + encodeURIComponent(RUNTIME_ARN_PREFIX + rt) + '/ws'
  req.querystring = {
    'qualifier': { value: 'DEFAULT' },
    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': { value: 'dsh-user-' + sub },
  }
  return req
}

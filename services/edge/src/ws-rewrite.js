// CloudFront Function（cloudfront-js-2.0，viewer-request），挂在 /api/remote.mux 行为上（源自 Spike 06）。
// 官方 Web UI 的 WebSocket 固定连 location.origin/api/remote.mux，且不带任何子协议或头，
// 所以由这里把它改写成 AgentCore Runtime 的 /ws 请求：
//   - 从 HttpOnly cookie dsh_token 取 Cognito 访问令牌，放进 Authorization: Bearer（由 JWT 授权器验签）
//   - runtimeSessionId = dsh-user-<令牌 sub>，作为查询参数（AgentCore 允许 /ws 用查询参数传会话 ID）
//   - URI 改为 /runtimes/<URL 编码的 Runtime ARN>/ws
// 这里只解码令牌、不验签：签名由 AgentCore 验证；容器内适配器再核对「会话 ID 属于令牌主体」。
// 下面的 Runtime ARN 占位符在部署时替换为 Runtime ARN（CDK 合成时它还是一个 CloudFormation 令牌，无法预先 URL 编码，所以在这里编码）。

// cloudfront-js-2.0 提供 Buffer；逐字符手工解码会超出函数指令上限（实测 RangeError: Instruction limit exceeded）
function b64urlDecode(s) {
  var b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return Buffer.from(b64, 'base64').toString('utf8')
}

function deny() {
  return { statusCode: 401, statusDescription: 'Unauthorized', headers: { 'content-type': { value: 'text/plain' } } }
}

function handler(event) {
  var req = event.request
  var c = req.cookies && req.cookies['dsh_token']
  if (!c || !c.value) return deny()
  var token = c.value
  var parts = token.split('.')
  if (parts.length !== 3) return deny()
  var sub
  try { sub = JSON.parse(b64urlDecode(parts[1])).sub } catch (e) { return deny() }
  if (!sub || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sub)) return deny()
  req.headers['authorization'] = { value: 'Bearer ' + token }
  delete req.headers['origin']
  delete req.headers['cookie']
  req.cookies = {}
  req.uri = '/runtimes/' + encodeURIComponent('__RUNTIME_ARN__') + '/ws'
  req.querystring = {
    'qualifier': { value: 'DEFAULT' },
    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': { value: 'dsh-user-' + sub },
  }
  return req
}

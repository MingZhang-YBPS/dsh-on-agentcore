// CloudFront Function（cloudfront-js-2.0，viewer-request），挂在默认行为与 /plugins/* 行为上。
// 1. DSH 的客户端插件合并加载 URL 形如 /plugins/??@a/client.js,@b/client.js&rev=xxx，查询串以「?」开头；
//    Lambda Function URL 对这种查询串直接返回 400 {"message":null}（Spike 06），请求根本到不了函数。
//    这里把原始查询串搬进 x-dsh-raw-query 头并清空查询串，由隧道 Lambda 还原。
//    querystring 对象的键顺序与原始 URL 不一致（Spike 06 实测 rev 排到了前面），而 DSH 要求「??」紧跟路径，
//    所以先放以「?」开头的键，再放其余键；同一个键的多个值保持原顺序。
// 2. /plugins/* 行为可被缓存（插件包与用户无关、URL 带内容哈希），缓存命中时请求不经过 Lambda 的鉴权，
//    因此这里要求请求至少带有 dsh_token cookie（只检查存在；令牌验签在未命中时由 AgentCore 完成）。

function handler(event) {
  var req = event.request
  if (req.uri.indexOf('/plugins/') === 0) {
    var c = req.cookies && req.cookies['dsh_token']
    if (!c || !c.value) {
      return { statusCode: 401, statusDescription: 'Unauthorized', headers: { 'content-type': { value: 'text/plain' }, 'cache-control': { value: 'no-store' } } }
    }
  }
  var qs = req.querystring || {}
  var keys = Object.keys(qs)
  var first = []
  var rest = []
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].charAt(0) === '?') first.push(keys[i])
    else rest.push(keys[i])
  }
  if (first.length === 0) return req
  var ordered = first.concat(rest)
  var parts = []
  for (var j = 0; j < ordered.length; j++) {
    var k = ordered[j]
    var entry = qs[k]
    var values = entry.multiValue ? entry.multiValue : [entry]
    for (var m = 0; m < values.length; m++) {
      var v = values[m].value
      parts.push(v === '' || v === undefined ? k : k + '=' + v)
    }
  }
  req.headers['x-dsh-raw-query'] = { value: encodeURIComponent(parts.join('&')) }
  req.querystring = {}
  return req
}

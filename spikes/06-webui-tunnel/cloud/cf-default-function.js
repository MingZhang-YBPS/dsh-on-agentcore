// CloudFront Function（cloudfront-js-2.0，viewer-request），挂在默认行为（→ 隧道 Lambda）上。
// DSH 的客户端插件合并加载 URL 形如 /plugins/??@a/client.js,@b/client.js&rev=xxx，查询串以「?」开头；
// Lambda Function URL 对这种查询串直接返回 400 {"message":null}（阶段 3 实测），请求根本到不了函数。
// 这里把原始查询串原样搬进 x-dsh-raw-query 头并清空查询串，由隧道 Lambda 还原。
function handler(event) {
  var req = event.request
  var qs = req.querystring
  var keys = Object.keys(qs)
  var needs = false
  for (var i = 0; i < keys.length; i++) if (keys[i].charAt(0) === '?') needs = true
  if (!needs) return req
  var parts = []
  // querystring 对象的键顺序与原始 URL 不一致（实测 rev 排到了前面），而 DSH 要求「??」紧跟路径，
  // 所以先放以「?」开头的键，再放其余键
  var ordered = []
  for (var a = 0; a < keys.length; a++) if (keys[a].charAt(0) === '?') ordered.push(keys[a])
  for (var b = 0; b < keys.length; b++) if (keys[b].charAt(0) !== '?') ordered.push(keys[b])
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

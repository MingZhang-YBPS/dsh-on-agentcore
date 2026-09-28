// 页面注入：让经 CloudFront 访问的 DSH_Web 使用主机端设置。
// DSH 的客户端只在「页面地址是回环地址」或「页面持有 Host」时把设置读写到主机（ctx.remote.$host.isLoopback，
// packages/client/connection/src/client/index.ts）；否则设置面板只在浏览器内存里生效，插件卡片也读不到主机的设置。
// 经 CloudFront 访问时页面地址不是回环地址，所以在首页 <head> 最前面注入官方的传输钩子 __DSH_TRANSPORT__：
// fetch 原样使用浏览器的 fetch，ownsHost=true 表示「这个页面独占它的 Host」——在本部署里每个用户一个 microVM，
// 且 DSH 只能经适配器访问，这个声明成立。
// 服务端不受影响：适配器把 Host 改写为 127.0.0.1，DSH 本来就把所有经适配器的请求视为本机请求；
// 设置写入的范围由 rpc-guard.ts 限制。

export const TRANSPORT_HOOK_SCRIPT =
  '<script>globalThis.__DSH_TRANSPORT__={fetch:(i,n)=>globalThis.fetch(i,n),ownsHost:true}</script>'

/** 是否是浏览器请求 HTML 页面（此时让 DSH 返回未压缩的响应，以便注入） */
export function wantsHtml(method: string, accept: string | readonly string[] | undefined): boolean {
  const a = Array.isArray(accept) ? accept.join(',') : String(accept ?? '')
  return method === 'GET' && /\btext\/html\b/.test(a)
}

/** 在第一个 <head> 之后插入钩子脚本；没有 <head> 或已注入过时原样返回 */
export function injectTransportHook(html: string): string {
  if (html.includes('__DSH_TRANSPORT__=')) return html
  const m = /<head(\s[^>]*)?>/i.exec(html)
  if (!m) return html
  const at = m.index + m[0].length
  return html.slice(0, at) + TRANSPORT_HOOK_SCRIPT + html.slice(at)
}

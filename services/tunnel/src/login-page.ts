// 最小的登录页：可访问的 label、autocomplete、role="alert" 的错误区域；不引用任何外部资源。

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function loginPage(message = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · DSH on AgentCore</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;justify-content:center;margin-top:12vh;color:#1a1a1a}
form{display:flex;flex-direction:column;gap:10px;width:300px}
input,button{font-size:16px;padding:8px}
input:focus-visible,button:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
button{cursor:pointer}
p[role=alert]{color:#b00020;min-height:1.2em;margin:0}
</style>
</head>
<body>
<main>
<form method="post" action="/auth/login">
<h1>DSH on AgentCore</h1>
<label for="u">用户名</label>
<input id="u" name="username" autocomplete="username" required maxlength="64">
<label for="p">口令</label>
<input id="p" name="password" type="password" autocomplete="current-password" required maxlength="128">
<button type="submit">登录</button>
<p role="alert" aria-live="assertive">${esc(message)}</p>
</form>
</main>
</body>
</html>`
}

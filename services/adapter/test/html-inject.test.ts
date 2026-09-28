import { describe, expect, it } from 'vitest'
import { TRANSPORT_HOOK_SCRIPT, injectTransportHook, wantsHtml } from '../src/html-inject.js'

describe('页面注入：传输钩子', () => {
  it('插在第一个 <head> 之后、DSH 自己的启动脚本之前', () => {
    const html = '<!doctype html>\n<html lang="en">\n  <head><base href="/"><script>(()=>{})()</script></head><body><head></head></body></html>'
    const out = injectTransportHook(html)
    expect(out.indexOf(TRANSPORT_HOOK_SCRIPT)).toBe(html.indexOf('<head>') + '<head>'.length)
    expect(out.split(TRANSPORT_HOOK_SCRIPT)).toHaveLength(2)
    expect(injectTransportHook('<HEAD data-x="1"><title>t</title>')).toBe(`<HEAD data-x="1">${TRANSPORT_HOOK_SCRIPT}<title>t</title>`)
  })

  it('没有 <head>、或已经注入过时原样返回（不会重复注入）', () => {
    expect(injectTransportHook('<p>no head</p>')).toBe('<p>no head</p>')
    const once = injectTransportHook('<head></head>')
    expect(injectTransportHook(once)).toBe(once)
    // <header> 不是 <head>
    expect(injectTransportHook('<header>x</header>')).toBe('<header>x</header>')
  })

  it('钩子声明页面独占 Host，fetch 原样使用浏览器的 fetch', () => {
    const g: Record<string, unknown> = { fetch: (i: unknown) => `fetched ${String(i)}` }
    new Function('globalThis', TRANSPORT_HOOK_SCRIPT.replace(/^<script>|<\/script>$/g, ''))(g)
    const t = g.__DSH_TRANSPORT__ as { ownsHost: boolean; fetch: (i: string) => unknown }
    expect(t.ownsHost).toBe(true)
    expect(t.fetch('/api/x')).toBe('fetched /api/x')
  })

  it('只有浏览器的 GET 页面请求才要求未压缩的 HTML', () => {
    expect(wantsHtml('GET', 'text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true)
    expect(wantsHtml('GET', ['text/html'])).toBe(true)
    expect(wantsHtml('POST', 'text/html')).toBe(false)
    expect(wantsHtml('GET', 'application/json')).toBe(false)
    expect(wantsHtml('GET', '*/*')).toBe(false)
    expect(wantsHtml('GET', undefined)).toBe(false)
  })
})

# 端到端阶段 C 结果

- 运行：2026-09-27T13:45:59.692Z；runId 3c4628；https://dsm2d40g257rc.cloudfront.net；Runtime dsh_poc_web-QEOKGXHwk4 v2；模型 deepseek.v3.2
- 用例 1，不符合预期 0

| 用例 | 用户 | 说明 | 结果 | 符合 |
|---|---|---|---|---|
| C20 | carol | 清除 /plugins/* 缓存后首次加载（未命中） | 登录→首页可用 9236 ms；插件请求 2 个（命中 0），传输 4178 KB；首页 TTFB 1475 ms；最慢：/plugins/??@deepseek-ai/dsh-api-gateway/ @1490+2597ms 4171KB；/assets/index-BKQ_L1z6.js @1491+1735ms 210KB；/assets/vendor-CCJJTK99.js @1491+1733ms 205KB；/plugins/??@deepseek-ai/dsh-client-modul @1490+1726ms 7KB；/assets/vendor-BNsW4eBh.css @ | 记录 |
| C21 | carol | 再次加载（新浏览器上下文，第 2 次） | 登录→首页可用 8408 ms；插件请求 2 个（命中 2），传输 4178 KB；首页 TTFB 2100 ms；最慢：/assets/index-BKQ_L1z6.js @2110+2214ms 210KB；/assets/vendor-CCJJTK99.js @2110+2213ms 205KB；/assets/index-DPX2bQLO.css @2110+2211ms 13KB；/assets/vendor-BNsW4eBh.css @2110+2211ms 9KB；/plugins/??@deepseek-ai/dsh-api-gateway/ @2109+1806ms 4171 | 记录 |
| C22 | carol | 再次加载（新浏览器上下文，第 3 次） | 登录→首页可用 10036 ms；插件请求 2 个（命中 2），传输 4178 KB；首页 TTFB 1913 ms；最慢：/assets/vendor-CCJJTK99.js @1922+2487ms 205KB；/assets/index-BKQ_L1z6.js @1922+2253ms 210KB；/assets/index-DPX2bQLO.css @1922+2251ms 13KB；/assets/vendor-BNsW4eBh.css @1922+2248ms 9KB；/plugins/??@deepseek-ai/dsh-api-gateway/ @1921+2085ms 417 | 记录 |
| C23 |  | 缓存预热后插件请求全部命中；对比首页加载耗时（需求 3.2：≤ 15 s） | 未命中 9236 ms（命中 0/2）；命中 8408 ms（2/2）、10036 ms（2/2） | ✓ |

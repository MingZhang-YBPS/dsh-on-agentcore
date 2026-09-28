// EdgeConstruct：CloudFront 分发 + 两个 CloudFront Function（源自 Spike 06，全部实测过的配置）。
//   默认行为        → 隧道 Lambda Function URL（带 X-Origin-Verify），不缓存，default-rewrite
//   /api/remote.mux → AgentCore 数据面（WebSocket），ws-rewrite 把 cookie 令牌改写成 Authorization 与 /ws 请求
//   /plugins/*      → 隧道 Lambda，可缓存（插件包 URL 带内容哈希，DSH 返回 immutable），缓存键含 x-dsh-raw-query

import { Duration, Fn, Stack } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import { Construct } from 'constructs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './bundle.js'
import type { RuntimeConstruct } from './runtime.js'
import type { TunnelConstruct } from './tunnel.js'

export const ARN_PLACEHOLDER = '__RUNTIME_ARN__'
const edgeSource = (name: string): string => readFileSync(join(REPO_ROOT, 'services', 'edge', 'src', name), 'utf8')

/** 把 ws-rewrite 源码中的 ARN 占位符替换成 Runtime ARN（合成时 ARN 还是 CloudFormation 令牌，所以用 Fn::Join） */
export function wsRewriteCode(runtimeArn: string): string {
  const parts = edgeSource('ws-rewrite.js').split(ARN_PLACEHOLDER)
  if (parts.length !== 2) throw new Error(`ws-rewrite.js must contain ${ARN_PLACEHOLDER} exactly once`)
  return Fn.join('', [parts[0] ?? '', runtimeArn, parts[1] ?? ''])
}

export class EdgeConstruct extends Construct {
  readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, tunnel: TunnelConstruct, rt: RuntimeConstruct) {
    super(scope, id)
    const region = Stack.of(this).region
    const js2 = cloudfront.FunctionRuntime.JS_2_0
    const defaultFn = new cloudfront.Function(this, 'DefaultRewrite', {
      comment: 'DSH PoC: move ??-queries into x-dsh-raw-query; /plugins requires dsh_token cookie',
      runtime: js2,
      code: cloudfront.FunctionCode.fromInline(edgeSource('default-rewrite.js')),
    })
    const wsFn = new cloudfront.Function(this, 'WsRewrite', {
      comment: 'DSH PoC: /api/remote.mux -> AgentCore /ws with Bearer token from cookie',
      runtime: js2,
      code: cloudfront.FunctionCode.fromInline(wsRewriteCode(rt.runtime.attrAgentRuntimeArn)),
    })

    const tunnelOrigin = new origins.FunctionUrlOrigin(tunnel.url, {
      customHeaders: { 'X-Origin-Verify': tunnel.originSecret.secretValue.unsafeUnwrap() },
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(5),
    })
    const agentcoreOrigin = new origins.HttpOrigin(`bedrock-agentcore.${region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(5),
    })
    // WebSocket 升级请求：Authorization 必须在缓存策略里才会转发（不能放进源请求策略）；TTL 0/1 等于不缓存
    const wsCache = new cloudfront.CachePolicy(this, 'WsCache', {
      comment: 'DSH PoC: forward Authorization + all query strings to AgentCore /ws',
      defaultTtl: Duration.seconds(0), minTtl: Duration.seconds(0), maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: false, enableAcceptEncodingBrotli: false,
    })
    // 插件包：与用户无关、URL 带内容哈希；遵从源站 Cache-Control（DSH 返回 public, max-age=31536000, immutable，错误响应是 no-store），最多缓存 1 天
    const pluginCache = new cloudfront.CachePolicy(this, 'PluginCache', {
      comment: 'DSH PoC: cache /plugins/* by path + x-dsh-raw-query + query strings',
      defaultTtl: Duration.days(1), minTtl: Duration.seconds(0), maxTtl: Duration.days(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('x-dsh-raw-query'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true, enableAcceptEncodingBrotli: true,
    })
    // 共享缓存的响应绝不能带 Set-Cookie（隧道 Lambda 已经不下发，这里再删一次）
    const noSetCookie = new cloudfront.ResponseHeadersPolicy(this, 'PluginNoSetCookie', {
      comment: 'DSH PoC: strip Set-Cookie from shared-cache responses',
      removeHeaders: ['Set-Cookie'],
    })
    const allViewer = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
    const viewerRequest = (f: cloudfront.IFunction): cloudfront.FunctionAssociation[] => [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: f }]

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'DSH PoC (official DSH Web UI on AgentCore Runtime)',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      defaultBehavior: {
        origin: tunnelOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: allViewer,
        compress: false,
        functionAssociations: viewerRequest(defaultFn),
      },
      additionalBehaviors: {
        '/api/remote.mux': {
          origin: agentcoreOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: wsCache,
          originRequestPolicy: allViewer,
          compress: false,
          functionAssociations: viewerRequest(wsFn),
        },
        '/plugins/*': {
          origin: tunnelOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: pluginCache,
          originRequestPolicy: allViewer,
          responseHeadersPolicy: noSetCookie,
          compress: true,
          functionAssociations: viewerRequest(defaultFn),
        },
      },
      // 默认会把 4xx/5xx 缓存 10 s：冷启动 502、失效令牌 403 这类响应不能被缓存（401 本来就不缓存，也不允许在这里配置）
      errorResponses: [400, 403, 404, 500, 502, 503, 504].map((httpStatus) => ({ httpStatus, ttl: Duration.seconds(0) })),
    })
  }
}

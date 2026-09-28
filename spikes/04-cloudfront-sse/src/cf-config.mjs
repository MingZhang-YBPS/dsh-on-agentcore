// 生成 Spike 04 的 CloudFront 配置 JSON。setup.sh 通过 `node src/cf-config.mjs <name>` 取用。
//
//   distribution  —— 分发配置（四个源，同一个 Function URL 域名，不同 OAC / 超时）
//   authz-policy  —— 把 Authorization 放进缓存键的缓存策略（no-override 行为必须用它才能转发 viewer 的 Authorization）
//
// 行为与源：
//   默认 *     → o30   OAC always，Response timeout 30（默认值）  CachingDisabled + AllViewerExceptHostHeader
//   /t60/*     → o60   OAC always，Response timeout 60            同上
//   /noov/*    → onoov OAC no-override，Response timeout 30       authz 缓存策略 + AllViewerExceptHostHeader
//   /nooac/*   → onone 无 OAC                                     CachingDisabled + AllViewerExceptHostHeader

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

function origin(id, domain, readTimeout, oacId) {
  return {
    Id: id,
    DomainName: domain,
    OriginPath: '',
    CustomHeaders: { Quantity: 0 },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'https-only',
      OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
      OriginReadTimeout: readTimeout,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
    OriginAccessControlId: oacId ?? '',
  };
}

function behavior(originId, cachePolicyId, pathPattern) {
  return {
    ...(pathPattern ? { PathPattern: pathPattern } : {}),
    TargetOriginId: originId,
    ViewerProtocolPolicy: 'https-only',
    AllowedMethods: {
      Quantity: 7,
      Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
      CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
    },
    CachePolicyId: cachePolicyId,
    OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
    Compress: false,
    SmoothStreaming: false,
    FieldLevelEncryptionId: '',
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    LambdaFunctionAssociations: { Quantity: 0 },
    FunctionAssociations: { Quantity: 0 },
  };
}

const docs = {
  distribution: () => {
    const domain = env('FN_DOMAIN');
    return {
      CallerReference: env('CALLER_REF'),
      Comment: 'dsh-poc-spike-04 CloudFront + Lambda Function URL SSE',
      Enabled: true,
      PriceClass: 'PriceClass_100',
      HttpVersion: 'http2',
      IsIPV6Enabled: true,
      Origins: {
        Quantity: 4,
        Items: [
          origin('o30', domain, 30, env('OAC_ALWAYS')),
          origin('o60', domain, 60, env('OAC_ALWAYS')),
          origin('onoov', domain, 30, env('OAC_NOOV')),
          origin('onone', domain, 30, null),
        ],
      },
      DefaultCacheBehavior: behavior('o30', CACHING_DISABLED),
      CacheBehaviors: {
        Quantity: 3,
        Items: [
          behavior('o60', CACHING_DISABLED, '/t60/*'),
          behavior('onoov', env('AUTHZ_CACHE_POLICY'), '/noov/*'),
          behavior('onone', CACHING_DISABLED, '/nooac/*'),
        ],
      },
    };
  },

  // TTL 全为 0 时不允许配置缓存键，因此 MaxTTL 取 1；源站返回 no-store，实际不会缓存。
  'authz-policy': () => ({
    Name: 'dsh-poc-spike-04-authz',
    Comment: 'Authorization in cache key so no-override OAC forwards viewer Authorization',
    DefaultTTL: 0,
    MaxTTL: 1,
    MinTTL: 0,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: false,
      EnableAcceptEncodingBrotli: false,
      HeadersConfig: { HeaderBehavior: 'whitelist', Headers: { Quantity: 1, Items: ['Authorization'] } },
      CookiesConfig: { CookieBehavior: 'none' },
      QueryStringsConfig: { QueryStringBehavior: 'all' },
    },
  }),
};

const name = process.argv[2];
if (!docs[name]) {
  console.error(`unknown config ${name}; one of: ${Object.keys(docs).join(', ')}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(docs[name](), null, 2));

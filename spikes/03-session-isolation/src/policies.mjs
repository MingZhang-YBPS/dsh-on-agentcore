// Spike 03 用到的全部 IAM 策略文档。setup.sh 通过 `node src/policies.mjs <name>` 取用，
// 避免在 shell 里拼 JSON。环境变量由 setup.sh 提供。
//
//   node src/policies.mjs exec-trust | exec-policy | gw-trust | gw-policy | ws-trust | ws-policy

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

// 工作空间访问权限：S3 前缀与 DynamoDB 分区键都由 ${aws:PrincipalTag/sessionId} 限定。
// 同一组语句同时挂在执行角色（验证 AgentCore 是否注入 sessionId 标签）与工作空间角色（接入服务注入标签）上。
function workspaceStatements(bucket, tableArn) {
  return [
    {
      Sid: 'WorkspaceObjects',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: `arn:aws:s3:::${bucket}/workspaces/\${aws:PrincipalTag/sessionId}/*`,
    },
    {
      Sid: 'WorkspaceList',
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: `arn:aws:s3:::${bucket}`,
      Condition: { StringLike: { 's3:prefix': ['workspaces/${aws:PrincipalTag/sessionId}/*'] } },
    },
    {
      Sid: 'WorkspaceHead',
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      Resource: tableArn,
      Condition: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['WORKSPACE#${aws:PrincipalTag/sessionId}'] },
      },
    },
    {
      Sid: 'RunControlRead',
      Effect: 'Allow',
      Action: 'dynamodb:GetItem',
      Resource: tableArn,
      Condition: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['SESSION#${aws:PrincipalTag/sessionId}'] },
      },
    },
  ];
}

const docs = {
  // 执行角色信任策略：在官方模板基础上额外允许 sts:TagSession，给 AgentCore 注入会话标签的机会。
  'exec-trust': () => {
    const account = env('ACCOUNT_ID');
    const region = env('REGION');
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AssumeRolePolicy',
          Effect: 'Allow',
          Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Condition: {
            StringEquals: { 'aws:SourceAccount': account },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${region}:${account}:*` },
          },
        },
      ],
    };
  },

  'exec-policy': () => {
    const account = env('ACCOUNT_ID');
    const region = env('REGION');
    const bucket = env('BUCKET');
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'Logs',
          Effect: 'Allow',
          Action: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
            'logs:DescribeLogGroups',
          ],
          Resource: [
            `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
            `arn:aws:logs:${region}:${account}:log-group:*`,
          ],
        },
        {
          Sid: 'WorkloadToken',
          Effect: 'Allow',
          Action: [
            'bedrock-agentcore:GetWorkloadAccessToken',
            'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
            'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
          ],
          Resource: [
            `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
            `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
          ],
        },
        {
          Sid: 'CodePackage',
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${bucket}/code/*`,
        },
        ...workspaceStatements(bucket, env('TABLE_ARN')),
      ],
    };
  },

  // 模拟接入服务 Lambda 角色：只信任运行本 spike 的 IAM 身份。
  'gw-trust': () => ({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: env('CALLER_ARN') },
        Action: 'sts:AssumeRole',
      },
    ],
  }),

  'gw-policy': () => ({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'MintWorkspaceCredentials',
        Effect: 'Allow',
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Resource: env('WS_ROLE_ARN'),
      },
    ],
  }),

  // 工作空间角色信任策略：只信任接入服务角色；必须携带形如 UUID 的 sessionId 标签，且不允许其他标签键。
  // 两个动作放在同一语句里，使「不带标签的 AssumeRole」同样被 aws:RequestTag 条件拒绝。
  'ws-trust': () => ({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'GatewayMintsSessionScopedCredentials',
        Effect: 'Allow',
        Principal: { AWS: env('GW_ROLE_ARN') },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Condition: {
          StringLike: { 'aws:RequestTag/sessionId': '????????-????-????-????-????????????' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': ['sessionId'] },
        },
      },
    ],
  }),

  'ws-policy': () => ({
    Version: '2012-10-17',
    Statement: workspaceStatements(env('BUCKET'), env('TABLE_ARN')),
  }),
};

const name = process.argv[2];
if (!docs[name]) {
  console.error(`unknown policy ${name}; one of: ${Object.keys(docs).join(', ')}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(docs[name](), null, 2));

// AuthConstruct：Cognito User Pool + App Client + 演示用户与运维用户（口令存放在 Secrets Manager）+ 登录节流表。

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import { join } from 'node:path'
import { REPO_ROOT } from './bundle.js'
import type { Params } from './params.js'

export class AuthConstruct extends Construct {
  readonly pool: cognito.UserPool
  readonly client: cognito.UserPoolClient
  readonly throttleTable: dynamodb.Table
  readonly userSecrets: Record<string, secrets.Secret> = {}

  constructor(scope: Construct, id: string, p: Params) {
    super(scope, id)
    this.pool = new cognito.UserPool(this, 'Pool', {
      selfSignUpEnabled: false,
      signInCaseSensitive: false,
      signInAliases: { username: true },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    this.client = this.pool.addClient('Client', {
      generateSecret: false,
      authFlows: { adminUserPassword: true, user: false, userPassword: false, userSrp: false, custom: false },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(p.tokenValidityHours),
      idTokenValidity: Duration.hours(p.tokenValidityHours),
      refreshTokenValidity: Duration.days(p.refreshTokenValidityDays),
      enableTokenRevocation: true,
    })
    this.throttleTable = new dynamodb.Table(this, 'ThrottleTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // 演示用户与运维用户（运维用户用于需要 Bearer 令牌的数据面调用，例如 StopRuntimeSession）
    const provisioner = new lambda.Function(this, 'UserProvisioner', {
      description: 'DSH PoC: create Cognito users and set their passwords from Secrets Manager',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(join(REPO_ROOT, 'infra', 'lambda', 'user-provisioner')),
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'UserProvisionerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    })
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminDeleteUser'],
      resources: [this.pool.userPoolArn],
    }))
    const provider = new cr.Provider(this, 'UserProvider', {
      onEventHandler: provisioner,
      logGroup: new logs.LogGroup(this, 'UserProviderLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    })
    for (const name of [...p.demoUsers, 'ops']) {
      const secret = new secrets.Secret(this, `User-${name}`, {
        description: `DSH PoC ${name === 'ops' ? 'ops' : 'demo'} user ${name}`,
        generateSecretString: { passwordLength: 24, requireEachIncludedType: true, excludeCharacters: '"\'\\`$&;|<>{}()[]' },
        removalPolicy: RemovalPolicy.DESTROY,
      })
      this.userSecrets[name] = secret
      secret.grantRead(provisioner)
      new CustomResource(this, `CognitoUser-${name}`, {
        serviceToken: provider.serviceToken,
        resourceType: 'Custom::DshPocUser',
        properties: { UserPoolId: this.pool.userPoolId, Username: name, SecretArn: secret.secretArn },
      })
    }
  }
}

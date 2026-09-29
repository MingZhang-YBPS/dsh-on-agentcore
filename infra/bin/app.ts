#!/usr/bin/env node
// CDK 应用入口：每次只合成一个栈，账号与区域取自当前凭证（CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION）。
//   -c stack=DshPoc（默认）    共享 Runtime + session storage（PoC，已部署的环境）
//   -c stack=DshPerUser        每名用户一个 Runtime + 独立 EFS（per-user-stack.ts）

import { App } from 'aws-cdk-lib'
import { DshPerUserStack, PER_USER_STACK_NAME } from '../lib/per-user-stack.js'
import { DshPocStack, STACK_NAME } from '../lib/stack.js'

const app = new App()
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
const which = String(app.node.tryGetContext('stack') ?? STACK_NAME)
if (which === STACK_NAME) {
  new DshPocStack(app, STACK_NAME, {
    description: 'DSH PoC: official DSH Web UI on Amazon Bedrock AgentCore Runtime (one runtime session per user)',
    env,
  })
} else if (which === PER_USER_STACK_NAME) {
  new DshPerUserStack(app, PER_USER_STACK_NAME, {
    description: 'DSH per-user: official DSH Web UI on Amazon Bedrock AgentCore Runtime (one runtime + one EFS file system per user)',
    env,
  })
} else {
  throw new Error(`context stack must be ${STACK_NAME} or ${PER_USER_STACK_NAME}`)
}
app.synth()

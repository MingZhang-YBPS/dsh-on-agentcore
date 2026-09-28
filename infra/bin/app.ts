#!/usr/bin/env node
// CDK 应用入口：单一 Stack，账号与区域取自当前凭证（CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION）。

import { App } from 'aws-cdk-lib'
import { DshPocStack, STACK_NAME } from '../lib/stack.js'

const app = new App()
new DshPocStack(app, STACK_NAME, {
  description: 'DSH PoC: official DSH Web UI on Amazon Bedrock AgentCore Runtime (one runtime session per user)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
})
app.synth()

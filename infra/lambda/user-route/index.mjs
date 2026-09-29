// 自定义资源（cr.Provider 的 onEvent，DshPerUser 栈）：每名用户一个，放在该用户的嵌套栈里。
//   创建/更新：路由表写入 USER#<用户名> → runtimeId；创建 Runtime 日志组（已存在则忽略）并设置保留期
//   删除：删除路由项与日志组（不存在则忽略）
// 共享一个 Provider，而不是每个嵌套栈各带一个 LogRetention / AwsCustomResource 的单例 Lambda。
// 属性：TableName、Username、RuntimeId、LogGroupName、RetentionDays。物理 ID = route/<用户名>。

import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs'

const ddb = new DynamoDBClient({})
const logs = new CloudWatchLogsClient({})

const ignore = (...names) => (e) => { if (!names.includes(e.name)) throw e }

async function remove(props) {
  await ddb.send(new DeleteItemCommand({ TableName: props.TableName, Key: { pk: { S: `USER#${props.Username}` } } }))
  await logs.send(new DeleteLogGroupCommand({ logGroupName: props.LogGroupName })).catch(ignore('ResourceNotFoundException'))
}

export async function handler(event) {
  const props = event.ResourceProperties
  const physicalId = `route/${props.Username}`
  if (event.RequestType === 'Delete') {
    await remove(props)
    return { PhysicalResourceId: event.PhysicalResourceId }
  }
  await ddb.send(new PutItemCommand({ TableName: props.TableName, Item: { pk: { S: `USER#${props.Username}` }, runtimeId: { S: props.RuntimeId } } }))
  await logs.send(new CreateLogGroupCommand({ logGroupName: props.LogGroupName })).catch(ignore('ResourceAlreadyExistsException'))
  await logs.send(new PutRetentionPolicyCommand({ logGroupName: props.LogGroupName, retentionInDays: Number(props.RetentionDays) }))
  // Runtime 被替换（ID 变了）时旧日志组留给 destroy 按前缀清理；路由项已被上面的 PutItem 覆盖
  return { PhysicalResourceId: physicalId }
}

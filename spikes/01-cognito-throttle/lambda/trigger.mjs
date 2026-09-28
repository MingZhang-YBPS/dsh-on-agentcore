// Spike 01: Cognito 触发器探针。
// 同一份代码部署为 PreAuthentication 与 PostAuthentication 两个函数。
// 每次被调用都输出一行带 marker 的结构化日志，供 collect-logs.sh 统计「触发器是否被调用」。
// 不记录口令（触发器事件本身也不包含口令）。

const LOCKED_USERS = new Set(
  (process.env.LOCKED_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export const handler = async (event) => {
  const req = event.request ?? {};
  console.log(
    JSON.stringify({
      marker: 'DSH_SPIKE_TRIGGER',
      fn: process.env.AWS_LAMBDA_FUNCTION_NAME,
      triggerSource: event.triggerSource,
      userName: event.userName,
      clientId: event.callerContext?.clientId,
      userNotFound: req.userNotFound,
      clientMetadata: req.clientMetadata ?? null,
      hasValidationData: req.validationData !== undefined,
      ts: Date.now(),
    }),
  );

  // 模拟「PreAuthentication 查到锁定状态后拒绝」，用于观察拒绝时 Cognito 返回的错误形态。
  if (event.triggerSource === 'PreAuthentication_Authentication' && LOCKED_USERS.has(event.userName)) {
    throw new Error('SPIKE_LOCKED');
  }
  return event;
};

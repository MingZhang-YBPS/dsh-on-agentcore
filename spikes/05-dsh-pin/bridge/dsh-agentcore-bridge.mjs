// DSH 桥接插件（Cordis 插件，运行在 dsh 子进程内）。
// 由 bridge.cordis.yml 以相对路径插入 headless 配置树，替代 headless-runner。
// 与父进程（适配层）经 Node IPC 通信（spawn 时 stdio 第 4 项为 'ipc'）：
//
//   父 → 子  {type:'prompt', id, text, context?: [{role, text}]}   开始一轮；context 仅在本进程首轮注入
//            {type:'cancel', id}                                    中止当前轮
//            {type:'shutdown'}
//   子 → 父  {type:'ready', provider, model, cwd, pid, ms}
//            {type:'delta', id, text} / {type:'reasoning', id, text}
//            {type:'tool_call', id, callId, name, arguments}
//            {type:'tool_result', id, callId, isError, errorCode, text}
//            {type:'assistant_message', id, interrupted, textLength}
//            {type:'turn_end', id, reason}
//            {type:'error', id?, message}
//
// 事件来源：token 级增量来自 'agent/assistant-stream'（进程内事件，SDK/ACP 都不转发）；
// 工具调用与轮次结束来自 durable 的 'session/event'。

import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const name = 'agentcore-bridge'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

const send = (msg) => {
  if (typeof process.send === 'function') process.send(msg)
}

function toolResultText(message) {
  const blocks = message?.content?.[0]?.content ?? message?.content ?? []
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('')
}

function transcript(context) {
  const lines = context.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.text}`)
  return `以下是本会话此前的对话记录（由宿主从历史存储恢复，按时间先后排列），请在此基础上继续：\n\n${lines.join('\n\n')}`
}

export function apply(ctx) {
  const t0 = Date.now()
  let agent = null
  let current = null // 当前轮的 prompt id
  let turns = 0

  async function ensureAgent() {
    if (agent) return agent
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const selection = defaultModel.currentSelection()
    const created = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      // setup 的返回值会被当作 AgentSetupCommit，必须用块语句、不返回任何值
      setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
    })
    agent = created.agent
    await agent.whenIdle()
    return agent
  }

  const disposers = []
  disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent || frame.type !== 'chunk') return
    const c = frame.chunk
    if (c.type === 'text-delta' && c.text !== '') send({ type: 'delta', id: current, text: c.text })
    else if (c.type === 'reasoning-delta' && c.text !== '') send({ type: 'reasoning', id: current, text: c.text })
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (!agent || session !== agent.session) return
    switch (event.type) {
      case 'tool/call':
        send({ type: 'tool_call', id: current, callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })
        break
      case 'tool/result': {
        const m = event.data.message
        send({
          type: 'tool_result', id: current, callId: m?.content?.[0]?.toolCallId ?? m?.source?.callId,
          isError: Boolean(m?.content?.[0]?.isError ?? m?.isError), errorCode: event.data.error?.code ?? null,
          text: toolResultText(m).slice(0, 2000),
        })
        break
      }
      case 'assistant/message': {
        const text = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        send({ type: 'assistant_message', id: current, interrupted: event.data.interrupted === true, textLength: text.length })
        break
      }
      case 'turn/end':
        send({ type: 'turn_end', id: current, reason: event.data.reason })
        break
      default:
        break
    }
  }))

  const onMessage = async (msg) => {
    try {
      if (msg?.type === 'prompt') {
        const a = await ensureAgent()
        current = msg.id
        if (turns === 0 && Array.isArray(msg.context) && msg.context.length > 0) {
          // 新进程（新 microVM）首轮：把历史存储中的上下文作为模型可见的上下文注入，不唤醒驱动
          a.inject(createUserMessage({
            content: [{ type: 'text', text: transcript(msg.context) }],
            source: { kind: 'plugin', plugin: name, form: 'recall' },
          }))
        }
        turns += 1
        a.followup(createUserMessage({ content: [{ type: 'text', text: msg.text }], source: { kind: 'user' } }))
      } else if (msg?.type === 'cancel') {
        agent?.cancel({ kind: 'user' })
      } else if (msg?.type === 'shutdown') {
        process.kill(process.pid, 'SIGTERM')
      }
    } catch (e) {
      send({ type: 'error', id: msg?.id, message: `${e?.name}: ${e?.message}` })
    }
  }
  process.on('message', onMessage)
  disposers.push(() => process.off('message', onMessage))

  void (async () => {
    try {
      await ensureAgent()
      const sel = ctx.get('agentDefaultModel').currentSelection()
      send({ type: 'ready', provider: sel.provider, model: sel.model, cwd: process.cwd(), pid: process.pid, ms: Date.now() - t0 })
    } catch (e) {
      send({ type: 'error', message: `startup: ${e?.name}: ${e?.message}` })
    }
  })()

  ctx.on('dispose', () => { for (const d of disposers) d() })
}

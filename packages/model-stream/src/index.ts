// 原始工具调用标记过滤（签名代理使用）。
//
// Bedrock 上的 deepseek.v3.2（bedrock-runtime 与 bedrock-mantle 两个端点面）在返回结构化 tool_calls 的同时，
// 会把模型原始的工具调用标记开头（`<｜DSML｜function_calls`）漏进 delta.content（Spike 07 实测 12/12 次）。
// 过滤器逐帧改写 OpenAI 兼容 SSE：某个 choice 的正文一旦出现标记，就丢弃标记及其后的正文；
// 片段末尾可能是标记的前缀时先扣住，下一片段或 finish_reason 到达时再决定放行还是丢弃。其余字段与帧数不变。

export const DEFAULT_RAW_MARKS: readonly string[] = ['<｜DSML｜', '<｜tool▁calls▁begin｜>', '<｜tool▁call▁begin｜>']

export interface FilterStats {
  /** 出现标记并被截断的 choice 次数 */
  stripped: number
  frames: number
}

export interface RawToolMarkupFilter {
  readonly stats: FilterStats
  /** 输入任意切块的上游字节，返回可以立即发给下游的字节（只包含完整的 SSE 帧） */
  push(chunk: Uint8Array): string
  /** 上游结束：返回剩余的不完整帧（原样） */
  end(): string
}

interface ChoiceState { dropping: boolean; held: string }
interface Choice { index?: number; delta?: { content?: unknown; [k: string]: unknown }; finish_reason?: unknown; [k: string]: unknown }

export function createRawToolMarkupFilter(marks: readonly string[] = DEFAULT_RAW_MARKS): RawToolMarkupFilter {
  if (marks.length === 0 || marks.some((m) => m.length === 0)) throw new Error('marks must be non-empty strings')
  const dec = new TextDecoder()
  const maxHold = Math.max(...marks.map((m) => m.length)) - 1
  let buf = ''
  const choices = new Map<number, ChoiceState>()
  const stats: FilterStats = { stripped: 0, frames: 0 }

  function filterContent(st: ChoiceState, content: string): string {
    const s = st.held + content
    st.held = ''
    if (st.dropping) return ''
    let cut = -1
    for (const m of marks) {
      const i = s.indexOf(m)
      if (i >= 0 && (cut < 0 || i < cut)) cut = i
    }
    if (cut >= 0) {
      st.dropping = true
      stats.stripped++
      return s.slice(0, cut).replace(/\s+$/u, '')
    }
    for (let k = Math.min(s.length, maxHold); k > 0; k--) {
      const tail = s.slice(-k)
      if (marks.some((m) => m.startsWith(tail))) { st.held = tail; return s.slice(0, -k) }
    }
    return s
  }

  function rewriteFrame(frame: string): string {
    stats.frames++
    const lines = frame.split('\n')
    const i = lines.findIndex((l) => l.startsWith('data:'))
    if (i < 0) return frame
    const payload = (lines[i] as string).slice(5).trim()
    if (payload === '[DONE]') return frame
    let obj: { choices?: Choice[] }
    try { obj = JSON.parse(payload) as { choices?: Choice[] } } catch { return frame }
    if (!Array.isArray(obj.choices)) return frame
    for (const c of obj.choices) {
      const idx = typeof c.index === 'number' ? c.index : 0
      const st = choices.get(idx) ?? { dropping: false, held: '' }
      choices.set(idx, st)
      if (c.delta && typeof c.delta.content === 'string') c.delta.content = filterContent(st, c.delta.content)
      if (c.finish_reason && st.held) {
        const prev = c.delta && typeof c.delta.content === 'string' ? c.delta.content : ''
        c.delta = { ...(c.delta ?? {}), content: prev + st.held }
        st.held = ''
      }
    }
    lines[i] = `data: ${JSON.stringify(obj)}`
    return lines.join('\n')
  }

  return {
    stats,
    push(chunk) {
      buf += dec.decode(chunk, { stream: true })
      let out = ''
      let j
      while ((j = buf.indexOf('\n\n')) >= 0) {
        out += rewriteFrame(buf.slice(0, j)) + '\n\n'
        buf = buf.slice(j + 2)
      }
      return out
    },
    end() {
      const rest = buf + dec.decode()
      buf = ''
      return rest
    },
  }
}

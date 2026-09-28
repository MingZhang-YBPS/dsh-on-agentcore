// Feature: poc, Property 10: 原始工具调用标记过滤
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_RAW_MARKS, createRawToolMarkupFilter } from '@dsh-poc/model-stream'
import { RUNS, arbChunking } from '../arbitraries/index.js'

type Frame = string | { choices: { index: number; delta: Record<string, unknown>; finish_reason: string | null }[]; usage?: unknown }
const toSse = (frames: Frame[]) => frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')

function summarize(sse: string) {
  const texts = new Map<number, string>()
  const other: unknown[] = []
  let frames = 0
  for (const fr of sse.split('\n\n').filter(Boolean)) {
    frames++
    const d = fr.slice(6)
    if (d === '[DONE]') { other.push('DONE'); continue }
    const o = JSON.parse(d) as { choices?: { index?: number; delta?: { content?: string; tool_calls?: unknown }; finish_reason?: unknown }[]; usage?: unknown }
    for (const c of o.choices ?? []) {
      const i = c.index ?? 0
      if (typeof c.delta?.content === 'string') texts.set(i, (texts.get(i) ?? '') + c.delta.content)
      other.push([i, c.delta?.tool_calls ?? null, c.finish_reason ?? null])
    }
    if (o.usage) other.push(o.usage)
  }
  return { texts, other, frames }
}

const beforeMark = (t: string): string | null => {
  let cut = -1
  for (const m of DEFAULT_RAW_MARKS) { const i = t.indexOf(m); if (i >= 0 && (cut < 0 || i < cut)) cut = i }
  return cut >= 0 ? t.slice(0, cut) : null
}
// 含标记：输出正文是标记前正文的前缀，差的只能是紧邻标记的空白（已经发出的片段无法收回）；不含标记：逐字相等
function expectText(after: string, before: string) {
  const pre = beforeMark(before)
  if (pre === null) { expect(after).toBe(before); return }
  expect(pre.startsWith(after)).toBe(true)
  expect(pre.slice(after.length)).toMatch(/^\s*$/u)
}

function run(input: Buffer, chunks: Buffer[]) {
  const f = createRawToolMarkupFilter()
  let out = ''
  for (const c of chunks) out += f.push(c)
  out += f.end()
  return { out, before: summarize(input.toString('utf8')), after: summarize(out) }
}

// 生成器：多 choice、正文片段随机（可含标记，标记可跨片段），可含 tool_calls、finish_reason、usage
const arbText = fc.string({ unit: 'grapheme', maxLength: 12 })
const arbPiece = fc.oneof({ weight: 5, arbitrary: arbText }, { weight: 1, arbitrary: fc.constantFrom(...DEFAULT_RAW_MARKS) }, { weight: 1, arbitrary: fc.constantFrom('<', '<｜', '<｜DS', '｜', '\n\n') })
const arbStream = fc.integer({ min: 1, max: 3 }).chain((nChoices) =>
  fc.array(fc.tuple(fc.integer({ min: 0, max: nChoices - 1 }), arbPiece, fc.boolean()), { minLength: 1, maxLength: 20 }).map((pieces) => {
    const frames: Frame[] = pieces.map(([i, text, tool]) => ({ choices: [{ index: i, delta: tool ? { content: text, tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{}' } }] } : { content: text }, finish_reason: null }] }))
    for (let i = 0; i < nChoices; i++) frames.push({ choices: [{ index: i, delta: {}, finish_reason: 'stop' }] })
    frames.push({ choices: [], usage: { total_tokens: pieces.length } })
    frames.push('[DONE]')
    return frames
  }),
)

describe('Property 10: 原始工具调用标记过滤', () => {
  it('任意流与任意切块：帧数不变、正文为首个标记之前的部分、其他字段不变', () => {
    fc.assert(fc.property(arbStream.chain((frames) => { const b = Buffer.from(toSse(frames)); return fc.tuple(fc.constant(b), arbChunking(b)) }), ([input, chunks]) => {
      const { out, before, after } = run(input, chunks)
      expect(after.frames).toBe(before.frames)
      for (const [i, t] of before.texts) expectText(after.texts.get(i) ?? '', t)
      for (const t of after.texts.values()) for (const m of DEFAULT_RAW_MARKS) expect(t.includes(m)).toBe(false)
      expect(after.other).toEqual(before.other)
      const hasMark = [...before.texts.values()].some((t) => DEFAULT_RAW_MARKS.some((m) => t.includes(m)))
      // 不含标记也不含 '<'（不会被扣住再放行）时，输出与输入逐字节相同
      const hasAngle = [...before.texts.values()].some((t) => t.includes('<'))
      if (!hasMark && !hasAngle) expect(out).toBe(input.toString('utf8'))
    }), { numRuns: RUNS.roundTrip })
  })

  // 以 Spike 07 录下的真实 Bedrock 流作为种子
  const dir = join(import.meta.dirname, '..', '..', 'spikes', '07-bedrock-model', 'results', 'probe-events')
  const seeds = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  it.skipIf(seeds.length === 0)('真实 Bedrock 流（Spike 07）：随机切块下结果正确', () => {
    for (const f of seeds) {
      const events = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { data: unknown }[]
      const input = Buffer.from(events.map((e) => `data: ${e.data === '[DONE]' ? '[DONE]' : JSON.stringify(e.data)}\n\n`).join(''))
      fc.assert(fc.property(arbChunking(input), (chunks) => {
        const { before, after } = run(input, chunks)
        expect(after.frames).toBe(before.frames)
        for (const [i, t] of before.texts) expectText(after.texts.get(i) ?? '', t)
        expect(after.other).toEqual(before.other)
      }), { numRuns: 50 })
    }
  })
})

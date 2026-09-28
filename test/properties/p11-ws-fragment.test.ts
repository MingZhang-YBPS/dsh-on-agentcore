// Feature: poc, Property 11: WebSocket 消息分片
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { WebSocket, WebSocketServer } from 'ws'
import { fragment } from '@dsh-poc/envelope'
import { RUNS, arbBytes } from '../arbitraries/index.js'

describe('Property 11: WebSocket 消息分片', () => {
  it('每帧不超过 max，只有最后一帧 fin，拼接后与原消息相等', () => {
    fc.assert(fc.property(arbBytes(200_000), fc.integer({ min: 1, max: 70_000 }), (msg, max) => {
      const fr = fragment(msg, max)
      expect(fr.length).toBeGreaterThanOrEqual(1)
      if (msg.length <= max) expect(fr).toHaveLength(1)
      fr.forEach((f, i) => {
        expect(f.data.length).toBeLessThanOrEqual(max)
        expect(f.fin).toBe(i === fr.length - 1)
        if (i < fr.length - 1) expect(f.data.length).toBe(max)
      })
      expect(Buffer.compare(Buffer.concat(fr.map((f) => f.data)), msg)).toBe(0)
    }), { numRuns: RUNS.roundTrip })
  })

  it('非法 max 抛错', () => {
    for (const m of [0, -1, 1.5, Number.NaN]) expect(() => fragment(Buffer.from('x'), m)).toThrow(RangeError)
  })

  it('集成：经 ws 库按分片发送，接收端收到完整消息（含切开多字节 UTF-8 字符的文本）', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = (wss.address() as { port: number }).port
    const messages = [
      { data: Buffer.from('历史'.repeat(40_000) + 'end'), binary: false },
      { data: Buffer.from('small'), binary: false },
      { data: Buffer.alloc(150_000, 7), binary: true },
    ]
    wss.on('connection', (ws) => {
      for (const m of messages) for (const f of fragment(m.data, 48 * 1024)) ws.send(f.data, { binary: m.binary, fin: f.fin })
    })
    const got = await new Promise<{ data: Buffer; binary: boolean }[]>((resolve, reject) => {
      const out: { data: Buffer; binary: boolean }[] = []
      const c = new WebSocket(`ws://127.0.0.1:${port}`)
      c.on('message', (d, binary) => { out.push({ data: Buffer.from(d as Buffer), binary }); if (out.length === messages.length) { c.close(); resolve(out) } })
      c.on('error', reject)
    })
    wss.close()
    got.forEach((g, i) => {
      expect(g.binary).toBe(messages[i]?.binary)
      expect(Buffer.compare(g.data, messages[i]?.data as Buffer)).toBe(0)
    })
  })
})

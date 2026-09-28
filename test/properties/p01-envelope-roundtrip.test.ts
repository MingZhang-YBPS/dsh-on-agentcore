// Feature: poc, Property 1: 封包往返一致性
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { decodeRequest, decodeResponseStream, encodeRequest, encodeResponseHead } from '@dsh-poc/envelope'
import { RUNS, arbBytes, arbChunking, arbHeaders, arbMethod, arbPath, toAsync } from '../arbitraries/index.js'

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of it) parts.push(c)
  return Buffer.concat(parts)
}

describe('Property 1: 封包往返一致性', () => {
  it('请求：decodeRequest(encodeRequest(x)) 与 x 逐项相等', () => {
    fc.assert(
      fc.property(arbMethod, arbPath, arbHeaders, arbBytes(), (method, path, headers, body) => {
        const r = decodeRequest(encodeRequest({ method, path, headers, body }))
        expect(r.method).toBe(method)
        expect(r.path).toBe(path)
        expect(r.headers).toEqual(headers)
        expect(Buffer.compare(Buffer.from(r.body), body)).toBe(0)
      }),
      { numRuns: RUNS.roundTrip },
    )
  })

  it('响应：任意切块下元数据与响应体都与编码前相等', async () => {
    const setCookie = fc.array(fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 3 })
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(fc.integer({ min: 100, max: 599 }), arbHeaders, fc.option(setCookie, { nil: undefined }), arbBytes(8192))
          .chain(([status, headers0, cookies, body]) => {
            const headers = cookies ? { ...headers0, 'set-cookie': cookies } : headers0
            const wire = Buffer.concat([encodeResponseHead({ status, headers }), body])
            return fc.tuple(fc.constant({ status, headers, body }), arbChunking(wire))
          }),
        async ([{ status, headers, body }, chunks]) => {
          const { head, rest } = await decodeResponseStream(toAsync(chunks))
          expect(head.status).toBe(status)
          expect(head.headers).toEqual(headers)
          expect(Buffer.compare(await collect(rest), body)).toBe(0)
        },
      ),
      { numRuns: RUNS.roundTrip },
    )
  })

  it('响应在元数据行之前结束时报错', async () => {
    await expect(decodeResponseStream(toAsync([Buffer.from('{"v":1,"status":200')]))).rejects.toThrow(/before header/)
  })
})

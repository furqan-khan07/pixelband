import { describe, expect, test, tier } from 'claude-code/testing'
import { inflateZlib } from '../hooks/inflate'
import { ZLIB } from './fixtures/images'

tier('user')

const b64 = (s: string) => Uint8Array.fromBase64(s)

describe('inflate', () => {
  for (const [name, c] of Object.entries(ZLIB)) {
    test(`inflates a ${name} zlib stream exactly`, async () => {
      expect(Array.from(inflateZlib(b64(c.z)))).toEqual(Array.from(b64(c.raw)))
    })
  }
  test('rejects a stream that is not zlib', async () => {
    expect(() => inflateZlib(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })
  test('rejects a truncated stream instead of hanging', async () => {
    const z = b64(ZLIB.dynamic.z)
    expect(() => inflateZlib(z.subarray(0, z.length >> 1))).toThrow()
  })
})

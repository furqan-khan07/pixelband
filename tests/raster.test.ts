import { describe, expect, test, tier } from 'claude-code/testing'
import { TRANSPARENT } from '../hooks/pixelate'
import { cellsFor, DEFAULT, rowsFor } from '../hooks/raster'

tier('user')

const decode = (b64: string) => Array.from(new Uint32Array(Uint8Array.fromBase64(b64).buffer))

describe('raster', () => {
  test('two pixels per cell: top as the upper-half block, bottom as its background', async () => {
    const art = { w: 1, h: 2, px: Uint32Array.of(0xff0000, 0x0000ff) }
    expect(decode(cellsFor(art))).toEqual([0x2580, 0xff0000, 0x0000ff])
  })

  test('transparent pixels show the terminal behind them', async () => {
    const art = { w: 3, h: 2, px: Uint32Array.of(TRANSPARENT, 0x00ff00, TRANSPARENT, 0x00ff00, TRANSPARENT, TRANSPARENT) }
    expect(decode(cellsFor(art))).toEqual([
      0x2584, 0x00ff00, DEFAULT,   // only the bottom is drawn: lower-half block
      0x2580, 0x00ff00, DEFAULT,   // only the top is drawn: upper-half block
      0x20, DEFAULT, DEFAULT,      // nothing: a plain space
    ])
  })

  test('an odd number of pixel rows leaves the last cell half empty', async () => {
    expect(rowsFor(5)).toBe(3)
    const art = { w: 1, h: 3, px: Uint32Array.of(1, 2, 3) }
    expect(decode(cellsFor(art)).slice(3)).toEqual([0x2580, 3, DEFAULT])
  })
})

import { describe, expect, test, tier } from 'claude-code/testing'
import { downscale, fit, medianCut, pixelate, shrinkToFit, TRANSPARENT } from '../hooks/pixelate'

tier('user')

const img = (w: number, h: number, f: (x: number, y: number) => number[]) => {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4)
  return { width: w, height: h, data }
}

describe('pixelate', () => {
  test('fit keeps the shape, two pixels per row, and never exceeds the width', async () => {
    expect(fit(200, 100, 6, 120)).toEqual({ w: 24, h: 12 })
    expect(fit(100, 100, 4, 120)).toEqual({ w: 8, h: 8 })
    expect(fit(1000, 100, 6, 40)).toEqual({ w: 40, h: 4 })
  })

  test('downscale averages colour, weighted by alpha, so see-through edges stay the right colour', async () => {
    const src = img(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]))
    const out = downscale(src, 1, 1)
    expect(Array.from(out.data)).toEqual([255, 0, 0, 127])
  })

  test('shrinkToFit only ever shrinks', async () => {
    const big = img(400, 200, () => [10, 20, 30, 255])
    expect([shrinkToFit(big, 128).width, shrinkToFit(big, 128).height]).toEqual([128, 64])
    const small = img(20, 10, () => [10, 20, 30, 255])
    expect(shrinkToFit(small, 128)).toBe(small)
  })

  test('median cut returns at most k colours', async () => {
    const colours: [number, number, number][] = []
    for (let i = 0; i < 300; i++) colours.push([i % 256, (i * 7) % 256, (i * 13) % 256])
    expect(medianCut(colours, 8).length).toBeLessThanOrEqual(8)
    expect(medianCut([], 8)).toEqual([])
  })

  test('the result uses no more colours than asked for, and keeps transparency', async () => {
    const src = img(60, 30, (x, y) => (x < 10 ? [0, 0, 0, 0] : [x * 4, y * 8, (x + y) * 3, 255]))
    const art = pixelate(src, 20, 10, 6)
    expect([art.w, art.h, art.px.length]).toEqual([20, 10, 200])
    const opaque = new Set(Array.from(art.px).filter((c) => c !== TRANSPARENT))
    expect(opaque.size).toBeLessThanOrEqual(6)
    expect(art.px[0]).toBe(TRANSPARENT)       // the see-through strip on the left
    expect(art.px[19]).not.toBe(TRANSPARENT)  // the right edge is solid
  })
})

import { describe, expect, test } from 'claude-code/testing'
import { TRANSPARENT } from '../hooks/pixelate'
import { SVG_LIMIT, svgFor, svgWithin } from '../hooks/svg'

const RED = 0xff0000, BLUE = 0x0000ff

describe('svg', () => {
  test('one path per colour, with each row of a colour as one run', () => {
    const px = Uint32Array.from([RED, RED, BLUE, RED, RED, RED])
    const doc = svgFor({ w: 3, h: 2, px })
    expect(doc).toContain('viewBox="0 0 3 2"')
    expect(doc).toContain('<path fill="#ff0000" d="M0 0h2.05v1.05H0zM0 1h3.05v1.05H0z"/>')
    expect(doc).toContain('<path fill="#0000ff" d="M2 0h1.05v1.05H2z"/>')
  })

  test('transparent pixels are left out', () => {
    const px = Uint32Array.from([TRANSPARENT, RED, TRANSPARENT, TRANSPARENT])
    const doc = svgFor({ w: 2, h: 2, px })
    expect(doc.match(/<path/g)?.length).toBe(1)
    expect(doc).toContain('d="M1 0h1.05v1.05H1z"')
  })

  test('a frame too busy for the limit is drawn coarser at the same size', () => {
    // A checkerboard is the worst case: every pixel is its own run.
    const w = 240, h = 48
    const px = new Uint32Array(w * h).map((_, i) => ((i % w) + Math.floor(i / w)) % 2 ? RED : BLUE)
    expect(svgFor({ w, h, px }).length).toBeGreaterThan(SVG_LIMIT)
    const doc = svgWithin({ w, h, px })
    expect(doc.length).toBeLessThanOrEqual(SVG_LIMIT)
    expect(doc).toContain(`width="${w * 12}" height="${h * 12}"`)
  })

  test('a frame that fits is drawn at full resolution', () => {
    const px = new Uint32Array(80 * 8).fill(RED)
    expect(svgWithin({ w: 80, h: 8, px })).toContain('viewBox="0 0 80 8"')
  })
})

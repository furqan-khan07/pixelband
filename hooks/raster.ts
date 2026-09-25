/**
 * Pixel art -> the cells of a `Raster` element.
 *
 * Each terminal cell shows two stacked pixels with the half-block trick: '▀' painted in the top
 * pixel's colour over a background of the bottom pixel's colour. Transparent pixels fall back to
 * the terminal's own default colours, so a logo with a see-through background blends in.
 */
import { TRANSPARENT, type Art } from './pixelate'

const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20
/** The terminal's default colour, in the Raster cell encoding. */
export const DEFAULT = 0x01000000

export function rowsFor(h: number): number {
  return Math.ceil(h / 2)
}

/** Encode `px` (w x h pixels) as base64 Raster cells, `w` columns by `rowsFor(h)` rows. */
export function cellsFor(art: Art, px: Uint32Array = art.px): string {
  const { w, h } = art
  const rows = rowsFor(h)
  const words = new Uint32Array(w * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < w; x++) {
      const top = px[2 * r * w + x]
      const bottom = 2 * r + 1 < h ? px[(2 * r + 1) * w + x] : TRANSPARENT
      const i = (r * w + x) * 3
      if (top === TRANSPARENT && bottom === TRANSPARENT) {
        words[i] = SPACE; words[i + 1] = DEFAULT; words[i + 2] = DEFAULT
      } else if (top === TRANSPARENT) {
        words[i] = LOWER; words[i + 1] = bottom; words[i + 2] = DEFAULT
      } else if (bottom === TRANSPARENT) {
        words[i] = UPPER; words[i + 1] = top; words[i + 2] = DEFAULT
      } else {
        words[i] = UPPER; words[i + 1] = top; words[i + 2] = bottom
      }
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

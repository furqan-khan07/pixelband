/**
 * Pixel art -> an SVG document, for apps that draw `Svg` but not `Raster` (the desktop app).
 *
 * Each colour becomes one path made of horizontal runs, so a flat sky costs a few characters per
 * row instead of one rectangle per pixel. Transparent pixels are left out and show the app's own
 * background, as the terminal's default colour does in a Raster.
 *
 * Each run reaches 0.05 of a pixel past its right and bottom edges. Scaled to fit the app, runs that
 * end exactly where the next begins leave hairline gaps the background shows through; the overlap
 * covers them and is far too small to see.
 */
import { TRANSPARENT, type Art } from './pixelate'

/** The most characters an `Svg` element's document may have. */
export const SVG_LIMIT = 131072
/** CSS pixels per art pixel in the markup; the app scales the drawing down to fit its slot. */
const SCALE = 12

const hex = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0')

/** Encode `px` (`art.w` x `art.h` pixels) as an SVG document with square pixels. */
export function svgFor(art: Art, px: Uint32Array = art.px): string {
  const { w, h } = art
  const runs = new Map<number, string[]>()
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      const c = px[y * w + x]
      let n = 1
      while (x + n < w && px[y * w + x + n] === c) n++
      if (c !== TRANSPARENT) {
        let d = runs.get(c)
        if (!d) runs.set(c, (d = []))
        d.push(`M${x} ${y}h${n}.05v1.05H${x}z`)
      }
      x += n
    }
  }
  let paths = ''
  for (const [c, d] of runs) paths += `<path fill="${hex(c)}" d="${d.join('')}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * SCALE}" height="${h * SCALE}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${paths}</svg>`
}

/** Halve the art's resolution (each output pixel is the top-left of a 2x2 block). */
function half(art: Art, px: Uint32Array): { art: Art; px: Uint32Array } {
  const w = Math.max(1, art.w >> 1), h = Math.max(1, art.h >> 1)
  const out = new Uint32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = px[2 * y * art.w + 2 * x]
  return { art: { w, h, px: out }, px: out }
}

/**
 * `svgFor`, coarser until it fits the element's limit. A busy, full-width frame (lots of single
 * pixels, as in rain or stars) can pass it at full resolution; half the pixels each way is a
 * quarter of the runs, and the drawing keeps its size because the viewBox shrinks with it.
 */
export function svgWithin(art: Art, px: Uint32Array = art.px, limit = SVG_LIMIT): string {
  let cur = { art, px }
  let doc = svgFor(cur.art, cur.px)
  while (doc.length > limit && cur.art.w > 1 && cur.art.h > 1) {
    cur = half(cur.art, cur.px)
    doc = svgFor(cur.art, cur.px).replace(/width="\d+" height="\d+"/, `width="${art.w * SCALE}" height="${art.h * SCALE}"`)
  }
  return doc
}

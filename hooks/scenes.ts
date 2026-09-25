/**
 * Built-in animated scenes, drawn from code instead of an image:
 *
 *   city     rain on a city at night: lit windows, a wet street, the odd flash of lightning
 *   space    stars drifting past a ringed planet; warp speed while Claude works
 *   aurora   northern lights over mountains and pines
 *   fire     a wall of fire (the classic Doom fire), flames climb while Claude works
 *
 * A scene is made for one band size and then asked for frames. Each frame gets the time, an
 * `energy` from 0 (idle) to 1 (Claude working) that eases between the two, and `flash`: how long
 * ago a turn finished, which each scene celebrates its own way.
 */
import { hash } from './effects'
import { TRANSPARENT } from './pixelate'

export const SCENES = ['city', 'space', 'aurora', 'fire'] as const
export type SceneName = (typeof SCENES)[number]

export interface SceneInput {
  /** ms since the scene started. */
  t: number
  /** 0 idle .. 1 working. */
  energy: number
  /** ms since a turn finished, or null. */
  flash: number | null
}

export type Renderer = (input: SceneInput) => Uint32Array

/** How long a scene's finish flourish lasts, in ms. */
export const FLASH_MS = 900

export function isScene(name: string): name is SceneName {
  return (SCENES as readonly string[]).includes(name)
}

export function makeScene(name: SceneName, w: number, h: number): Renderer {
  switch (name) {
    case 'city': return city(w, h)
    case 'space': return space(w, h)
    case 'aurora': return aurora(w, h)
    case 'fire': return fire(w, h)
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers: a float RGB canvas, packed to 0xRRGGBB at the end.

type Rgb = readonly [number, number, number]

class Canvas {
  readonly buf: Float32Array
  constructor(readonly w: number, readonly h: number) { this.buf = new Float32Array(w * h * 3) }
  set(x: number, y: number, c: Rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const o = (y * this.w + x) * 3
    this.buf[o] = c[0]; this.buf[o + 1] = c[1]; this.buf[o + 2] = c[2]
  }
  /** Blend toward `c` by `k`. */
  mix(x: number, y: number, c: Rgb, k: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || k <= 0) return
    if (k > 1) k = 1
    const o = (y * this.w + x) * 3
    this.buf[o] += (c[0] - this.buf[o]) * k
    this.buf[o + 1] += (c[1] - this.buf[o + 1]) * k
    this.buf[o + 2] += (c[2] - this.buf[o + 2]) * k
  }
  get(x: number, y: number): Rgb {
    x = Math.min(this.w - 1, Math.max(0, x)); y = Math.min(this.h - 1, Math.max(0, y))
    const o = (y * this.w + x) * 3
    return [this.buf[o], this.buf[o + 1], this.buf[o + 2]]
  }
  pack(): Uint32Array {
    const out = new Uint32Array(this.w * this.h)
    const c = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))
    for (let i = 0; i < out.length; i++) {
      out[i] = ((c(this.buf[i * 3]) << 16) | (c(this.buf[i * 3 + 1]) << 8) | c(this.buf[i * 3 + 2])) >>> 0
    }
    return out
  }
}

const lerp = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
const smooth = (k: number) => k * k * (3 - 2 * k)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Smooth value noise in [0, 1). */
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed)
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/** A finished-turn pulse: 1 right at the finish, fading to 0 over FLASH_MS. */
const pulse = (flash: number | null) => (flash === null || flash >= FLASH_MS ? 0 : (1 - flash / FLASH_MS) ** 2)

// ---------------------------------------------------------------------------------------------
// city: rain on a city at night

function city(w: number, h: number): Renderer {
  const NEON: Rgb[] = [[255, 64, 170], [60, 232, 255], [180, 110, 255]]
  const ground = h >= 10 ? Math.max(2, Math.round(h * 0.17)) : h >= 6 ? 1 : 0
  const y0 = h - ground // first row of street

  interface Building { x: number; w: number; top: number; seed: number; antenna: boolean; setback: number; neon: number }
  const far: Building[] = [], near: Building[] = []
  for (let x = -1, i = 0; x < w; i++) {
    const bw = 3 + Math.floor(hash(i, 1, 11) * 5)
    far.push({ x, w: bw, top: Math.round(y0 * (0.3 + hash(i, 2, 11) * 0.4)), seed: i, antenna: false, setback: 0, neon: -1 })
    x += bw
  }
  let signs = 0
  for (let x = -2, i = 0; x < w; i++) {
    const bw = 4 + Math.floor(hash(i, 1, 13) * 8)
    const tall = hash(i, 5, 13) < 0.25
    const top = Math.round(y0 * (tall ? 0.08 + hash(i, 2, 13) * 0.2 : 0.35 + hash(i, 2, 13) * 0.35))
    const setback = bw >= 6 && hash(i, 6, 13) < 0.5 ? 2 + Math.floor(hash(i, 7, 13) * 2) : 0
    const neon = y0 - top >= 8 && hash(i, 8, 13) < 0.3 ? signs++ % NEON.length : -1
    near.push({ x, w: bw, top, seed: 100 + i, antenna: tall && top >= 4 && hash(i, 3, 13) < 0.7, setback, neon })
    x += bw + (hash(i, 4, 13) < 0.3 ? 1 : 0)
  }
  const nearAt = new Int32Array(w).fill(-1)
  near.forEach((b, i) => { for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.w); x++) nearAt[x] = i })
  const farAt = new Int32Array(w).fill(-1)
  far.forEach((b, i) => { for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.w); x++) farAt[x] = i })

  const SKY_TOP: Rgb = [5, 7, 22], SKY_MID: Rgb = [22, 18, 50], GLOW: Rgb = [92, 44, 74]
  const CLOUD: Rgb = [52, 48, 84], LIGHTNING: Rgb = [196, 198, 240]
  const FAR: Rgb = [38, 32, 70], NEAR: Rgb = [9, 9, 18], STREET: Rgb = [10, 10, 20]
  const RAIN: Rgb = [178, 194, 236]
  const WARM: Rgb = [255, 196, 108], COOL: Rgb = [164, 204, 255], AMBER: Rgb = [206, 122, 58], DIM: Rgb = [128, 104, 84]

  /** Lightning brightness at time t: random strikes every so often, plus one on a finish. */
  function lightning(t: number, energy: number, flash: number | null): { k: number; slot: number } {
    const SLOT = 9000
    let best = { k: 0, slot: -1 }
    const shape = (dt: number) => (dt < 0 ? 0 : dt < 70 ? 1 : dt < 140 ? 0.25 : dt < 220 ? 0.85 : Math.exp(-(dt - 220) / 180) * 0.6)
    for (const s of [Math.floor(t / SLOT), Math.floor(t / SLOT) - 1]) {
      if (s < 0 || hash(s, 0, 31) > 0.3 + 0.3 * energy) continue
      const k = shape(t - (s * SLOT + hash(s, 1, 31) * (SLOT - 1500)))
      if (k > best.k) best = { k, slot: s }
    }
    if (flash !== null) {
      const k = shape(flash)
      if (k > best.k) best = { k, slot: 1_000_000 + Math.floor((t - flash) / 100) }
    }
    return best
  }

  return ({ t, energy, flash }) => {
    const c = new Canvas(w, h)
    const L = lightning(t, energy, flash)
    const sky = new Uint8Array(w * h)

    // sky, with slow clouds
    for (let y = 0; y < y0; y++) {
      const v = y0 > 1 ? y / (y0 - 1) : 1
      const base = v < 0.55 ? lerp(SKY_TOP, SKY_MID, v / 0.55) : lerp(SKY_MID, GLOW, ((v - 0.55) / 0.45) ** 1.4)
      for (let x = 0; x < w; x++) {
        c.set(x, y, base)
        const n = noise(x * 0.06 + t * 0.0004, y * 0.3, 41) * 0.7 + noise(x * 0.15 + t * 0.0007, y * 0.6, 43) * 0.3
        c.mix(x, y, CLOUD, smooth(clamp01((n - 0.45) / 0.35)) * (0.45 - v * 0.25))
        if (L.k > 0) c.mix(x, y, LIGHTNING, L.k * (0.55 + n * 0.3) * (1 - v * 0.4))
        sky[y * w + x] = 1
      }
    }

    // the lightning bolt itself, behind the buildings
    if (L.k > 0.6 && y0 > 4) {
      let bx = Math.floor(hash(L.slot, 2, 31) * w)
      const end = Math.floor(y0 * (0.55 + hash(L.slot, 3, 31) * 0.35))
      for (let y = 0; y < end; y++) {
        bx += Math.round((hash(L.slot, y, 33) - 0.5) * 2.6)
        if (sky[y * w + bx]) c.set(bx, y, [250, 250, 255])
        if (hash(L.slot, y, 35) < 0.12) { // a small fork
          const fx = bx + (hash(L.slot, y, 37) < 0.5 ? -1 : 1)
          c.mix(fx, y + 1, [220, 220, 255], 0.8)
        }
      }
    }

    // far skyline: flat silhouettes against the glow, a few dim windows
    const lit = (x: number, y: number, seed: number, p: number) => {
      const period = 5 + hash(x, y, seed + 7) * 12
      const epoch = Math.floor((t / 1000 + hash(x, y, seed + 9) * 40) / period)
      return hash(x, y, seed + epoch * 131) < p
    }
    for (let x = 0; x < w; x++) {
      const b = far[farAt[x]]
      if (!b) continue
      for (let y = b.top; y < y0; y++) {
        c.set(x, y, L.k > 0 ? lerp(FAR, [70, 66, 110], L.k * 0.5) : FAR)
        sky[y * w + x] = 0
        if ((x - b.x) % 2 === 1 && (y - b.top) % 3 === 2 && x < b.x + b.w - 1 && lit(x, y, 5, 0.14)) c.set(x, y, DIM)
      }
    }

    // near skyline: dark towers full of windows that switch on and off, antennas blinking red
    for (let x = 0; x < w; x++) {
      const b = near[nearAt[x]]
      if (!b) continue
      const col = x - b.x
      const inset = col < 1 || col >= b.w - 1
      const top = b.setback && inset ? b.top + b.setback : b.top
      for (let y = top; y < y0; y++) {
        c.set(x, y, NEAR)
        sky[y * w + x] = 0
        const row = y - b.top
        if (col % 2 === 1 && col < b.w - 1 && row % 2 === 1 && y < y0 - 1 && lit(x, y, b.seed, 0.4)) {
          const tone = hash(x, y, b.seed + 3)
          c.set(x, y, tone < 0.68 ? WARM : tone < 0.88 ? COOL : AMBER)
        }
      }
      // a neon sign down one edge, flickering now and then
      if (b.neon >= 0 && col === (b.seed % 2 ? 1 : b.w - 2)) {
        const flick = hash(b.seed, Math.floor(t / 90), 29) < 0.04
        for (let y = b.top + 2; y < Math.min(y0 - 1, b.top + 7); y++) c.set(x, y, flick ? [40, 20, 40] : NEON[b.neon])
      }
      if (b.antenna && x === b.x + (b.w >> 1)) {
        for (let y = b.top - 3; y < b.top; y++) c.set(x, y, NEAR)
        const blink = (t + b.seed * 377) % 1600 < 500
        c.set(x, b.top - 3, blink ? [255, 48, 60] : [70, 16, 24])
      }
    }

    // wet street: a rippling reflection of everything above it
    for (let gy = 0; gy < ground; gy++) {
      const y = y0 + gy
      for (let x = 0; x < w; x++) {
        const dx = Math.round((noise(x * 0.25, gy * 1.3 + t * 0.004, 51) - 0.5) * 3)
        const src = c.get(x + dx, y0 - 1 - Math.floor(gy * 0.6))
        const lum = (src[0] + src[1] + src[2]) / 3
        c.set(x, y, lerp(STREET, src, lum > 90 ? 0.75 - gy * 0.08 : 0.4 - gy * 0.06))
        if (gy === 0) c.mix(x, y, [40, 36, 60], 0.35)
      }
    }

    // rain, heavier while Claude works
    const drops = Math.floor(w * h * (0.012 + 0.03 * energy))
    const fall = h + 4
    const SLANT = 0.3
    for (let i = 0; i < drops; i++) {
      const front = hash(i, 4, 21) < 0.25
      const speed = h * (1.8 + hash(i, 1, 21) * 0.8) * (front ? 1.25 : 1) * (1 + energy * 0.35) / 1000 // px per ms
      const p = ((t * speed + hash(i, 2, 21) * fall) % fall) - 3
      const x0 = hash(i, 3, 21) * (w + h * SLANT)
      const len = front ? 4 : 2
      for (let s = 0; s < len; s++) {
        const y = Math.floor(p) - s
        c.mix(Math.round(x0 - (p - s) * SLANT), y, RAIN, (front ? 0.8 : 0.5) * (1 - s / (len + 0.5)))
      }
    }
    // splashes on the street
    const tick = Math.floor(t / 80)
    for (let y = y0; y < h; y++) {
      for (let x = 0; x < w; x++) if (hash(x, y * 7 + tick, 23) < 0.012 + 0.03 * energy) c.mix(x, y, RAIN, 0.55)
    }
    return c.pack()
  }
}

// ---------------------------------------------------------------------------------------------
// space: parallax stars and a ringed planet; warp speed while Claude works

function space(w: number, h: number): Renderer {
  const layers = [
    { density: 0.03, speed: 1.2, bright: 0.45 },
    { density: 0.014, speed: 3.5, bright: 0.75 },
    { density: 0.006, speed: 9, bright: 1 },
  ]
  const TINTS: Rgb[] = [[255, 255, 255], [190, 210, 255], [255, 236, 200], [255, 200, 200]]
  const R = Math.max(2, h * 0.42)
  const px0 = w * 0.76, py0 = h * 0.58
  const BANDS: Rgb[] = [[214, 160, 104], [178, 112, 72], [232, 196, 140], [150, 86, 62], [204, 142, 92]]
  let warp = 0 // eased separately so stars stretch smoothly

  return ({ t, energy, flash }) => {
    const c = new Canvas(w, h)
    warp += (energy - warp) * 0.15
    // deep space with a faint nebula
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        c.set(x, y, lerp([3, 3, 12], [9, 6, 22], y / h))
        const n = noise(x * 0.05 + t * 0.00005, y * 0.12, 61)
        const m = noise(x * 0.09, y * 0.2 + t * 0.00003, 63)
        c.mix(x, y, [70, 30, 100], smooth(clamp01((n - 0.55) / 0.4)) * 0.45)
        c.mix(x, y, [20, 70, 110], smooth(clamp01((m - 0.6) / 0.4)) * 0.35)
      }
    }
    // stars: each layer drifts left at its own speed; at warp they streak
    const mult = 1 + warp * 30
    layers.forEach((L, li) => {
      const n = Math.max(1, Math.floor(w * h * L.density))
      const len = Math.min(w / 2, L.speed * mult * 0.12)
      for (let i = 0; i < n; i++) {
        const span = w + len + 2
        const x = ((hash(i, li, 71) * span - (t / 1000) * L.speed * mult) % span + span) % span - 1
        const y = Math.floor(hash(i, li, 73) * h)
        const tw = li === 0 ? 0.55 + 0.45 * Math.sin(t / 400 + i * 1.7) : 1
        const tint = TINTS[Math.floor(hash(i, li, 75) * TINTS.length)]
        const k = L.bright * tw
        c.mix(Math.floor(x), y, tint, k)
        for (let s = 1; s <= len; s++) c.mix(Math.floor(x) + s, y, tint, k * (1 - s / (len + 1)) * 0.8)
      }
    })
    // a shooting star every so often
    const SLOT = 7000, s = Math.floor(t / SLOT)
    if (hash(s, 0, 77) < 0.5) {
      const dt = t - s * SLOT - hash(s, 1, 77) * 5000
      if (dt > 0 && dt < 500) {
        const sx = hash(s, 2, 77) * w * 0.7 + (dt / 500) * w * 0.3, sy = hash(s, 3, 77) * h * 0.4 + (dt / 500) * h * 0.3
        for (let k = 0; k < 5; k++) c.mix(Math.floor(sx - k), Math.floor(sy - k * 0.5), [255, 255, 255], 0.9 - k * 0.18)
      }
    }
    // ringed planet, lit from the upper left; bands drift as it turns
    const ring = (x: number, y: number, front: boolean) => {
      const dx = (x + 0.5 - px0) / (R * 2.1), dy = (y + 0.5 - py0) / (R * 0.42)
      const d = dx * dx + dy * dy
      if (d < 0.55 || d > 1) return
      if (front !== (y + 0.5 >= py0)) return
      c.mix(x, y, d < 0.75 ? [226, 204, 160] : [178, 150, 116], 0.9)
    }
    const x0 = Math.max(0, Math.floor(px0 - R * 2.2)), x1 = Math.min(w, Math.ceil(px0 + R * 2.2))
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) ring(x, y, false)
    for (let y = Math.floor(py0 - R); y <= Math.ceil(py0 + R); y++) {
      for (let x = Math.floor(px0 - R); x <= Math.ceil(px0 + R); x++) {
        const nx = (x + 0.5 - px0) / R, ny = (y + 0.5 - py0) / R
        const r2 = nx * nx + ny * ny
        if (r2 > 1) continue
        const nz = Math.sqrt(1 - r2)
        const light = clamp01(-0.55 * nx - 0.45 * ny + 0.7 * nz)
        const band = BANDS[Math.floor(noise(ny * 3.2, nx * 0.6 + t * 0.00015, 81) * 2.99 + (ny + 1) * 1.6) % BANDS.length]
        const shade = light < 0.18 ? 0.22 : light < 0.45 ? 0.55 : light < 0.75 ? 0.85 : 1.05
        c.set(x, y, [band[0] * shade, band[1] * shade, band[2] * shade])
      }
    }
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) ring(x, y, true)
    // finish: a hyperspace flash
    const f = pulse(flash)
    if (f > 0) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c.mix(x, y, [210, 225, 255], f * 0.4)
    return c.pack()
  }
}

// ---------------------------------------------------------------------------------------------
// aurora: northern lights over mountains and pines

function aurora(w: number, h: number): Renderer {
  const ridge = new Float32Array(w).fill(h)
  const lit = new Uint8Array(w) // which side of its peak a column is on
  for (let px = -8, i = 0; px < w + 8; i++) {
    const top = h * (0.34 + hash(i, 0, 91) * 0.26), slope = 0.55 + hash(i, 1, 91) * 0.35
    for (let x = 0; x < w; x++) {
      const y = top + Math.abs(x - px) * slope + (noise(x * 0.5, i, 93) - 0.5) * 1.2
      if (y < ridge[x]) { ridge[x] = y; lit[x] = x < px ? 1 : 0 }
    }
    px += 10 + Math.floor(hash(i, 2, 91) * 14)
  }
  const snowline = h * 0.5
  const trees: { x: number; top: number }[] = []
  for (let x = 0; x < w; x += 2 + Math.floor(hash(x, 0, 95) * 3)) {
    trees.push({ x, top: Math.round(h * (0.74 + hash(x, 1, 95) * 0.14)) })
  }
  const GREEN: Rgb = [70, 255, 158], TEAL: Rgb = [60, 200, 210], VIOLET: Rgb = [168, 90, 236]
  let glow = 0

  return ({ t, energy, flash }) => {
    const c = new Canvas(w, h)
    glow += (energy - glow) * 0.08
    const speed = 1 + glow * 1.6
    const bright = 0.7 + glow * 0.3 + pulse(flash) * 0.6
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        c.set(x, y, lerp([2, 5, 16], [8, 24, 38], y / h))
        if (hash(x, y, 97) < 0.025) c.mix(x, y, [230, 240, 255], 0.35 + 0.35 * Math.sin(t / 500 + x * 3.1 + y))
      }
    }
    // the curtains: a wavy lower edge with rays rising from it
    for (let x = 0; x < w; x++) {
      const edge = h * 0.48 + Math.sin(x * 0.08 + t * 0.00035 * speed) * h * 0.13 + Math.sin(x * 0.21 - t * 0.0006 * speed) * h * 0.06
      const rays = 0.35 + 0.65 * noise(x * 0.3 + t * 0.0009 * speed, t * 0.0002, 99)
      for (let y = 0; y < h; y++) {
        const above = edge - y
        const k = above >= 0 ? Math.exp(-above / (h * 0.3)) * rays : Math.exp(above * 1.4) * rays
        if (k < 0.02) continue
        const col = above < h * 0.12 ? GREEN : above < h * 0.28 ? lerp(GREEN, TEAL, (above - h * 0.12) / (h * 0.16)) : lerp(TEAL, VIOLET, clamp01((above - h * 0.28) / (h * 0.2)))
        c.mix(x, y, col, k * 0.8 * bright)
      }
    }
    // mountains, snow catching the aurora's light
    for (let x = 0; x < w; x++) {
      const top = Math.round(ridge[x])
      for (let y = top; y < h; y++) {
        const snow = y < snowline + (noise(x * 0.4, 5, 94) - 0.5) * 2
        const rock: Rgb = lit[x] ? [30, 42, 64] : [18, 26, 44]
        const cap: Rgb = lit[x] ? [196, 214, 230] : [120, 142, 170]
        c.set(x, y, snow ? lerp(cap, GREEN, 0.15 * bright) : rock)
      }
    }
    // pines along the bottom
    for (const tr of trees) {
      for (let y = tr.top; y < h; y++) {
        const half = Math.floor((y - tr.top) / 2)
        for (let dx = -half; dx <= half; dx++) c.set(tr.x + dx, y, [3, 8, 12])
      }
    }
    return c.pack()
  }
}

// ---------------------------------------------------------------------------------------------
// fire: the Doom fire, over your terminal's own background

function fire(w: number, h: number): Renderer {
  const PALETTE: number[] = [
    0x070707, 0x1f0707, 0x2f0f07, 0x470f07, 0x571707, 0x671f07, 0x771f07, 0x8f2707, 0x9f2f07,
    0xaf3f07, 0xbf4707, 0xc74707, 0xdf4f07, 0xdf5707, 0xdf5707, 0xd75f07, 0xd7670f, 0xcf6f0f,
    0xcf770f, 0xcf7f0f, 0xcf8717, 0xc78717, 0xc78f17, 0xc7971f, 0xbf9f1f, 0xbf9f1f, 0xbfa727,
    0xbfa727, 0xbfaf2f, 0xb7af2f, 0xb7b72f, 0xb7b737, 0xcfcf6f, 0xdfdf9f, 0xefefc7, 0xffffff, 0xffffff,
  ]
  const MAX = PALETTE.length - 1
  const heat = new Float32Array(w * h)
  const STEP_MS = 40
  let step = -1
  let reach = 0.45

  function advance(s: number, energy: number, boost: number) {
    const target = 0.45 + energy * 0.5 + boost * 0.3
    reach += (target - reach) * 0.05
    const decayPerRow = MAX / (Math.max(2, h) * reach)
    const wind = (noise(s * 0.01, 0, 104) - 0.5) * 0.6
    for (let x = 0; x < w; x++) {
      const n = noise(x * 0.09, s * 0.02, 101) * 0.65 + noise(x * 0.3, s * 0.05, 102) * 0.35
      heat[(h - 1) * w + x] = MAX * (0.5 + 0.5 * n)
    }
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const r = hash(x, y, s * 7 + 103)
        const src = heat[(y + 1) * w + x]
        const tongue = 0.55 + noise(x * 0.18, (y + s * 0.6) * 0.15, 106) * 0.9
        const decay = decayPerRow * (0.3 + r * 1.4) * tongue
        const dx = r < 0.33 + wind ? -1 : r < 0.66 + wind ? 0 : 1
        const tx = Math.min(w - 1, Math.max(0, x + dx))
        heat[y * w + tx] = Math.max(0, src - decay)
      }
    }
  }

  return ({ t, energy, flash }) => {
    const target = Math.floor(t / STEP_MS)
    if (step < 0 || target < step) step = target - 30 // fresh start: warm it up
    const boost = pulse(flash)
    for (let s = Math.max(step + 1, target - 30); s <= target; s++) advance(s, energy, boost)
    step = target
    const out = new Uint32Array(w * h)
    for (let i = 0; i < out.length; i++) {
      const v = Math.round(heat[i])
      out[i] = v <= 1 ? TRANSPARENT : PALETTE[Math.min(MAX, v)]
    }
    // embers drifting up, more of them on a finish
    const embers = Math.floor(w * (0.04 + 0.05 * energy + boost * 0.25))
    for (let i = 0; i < embers; i++) {
      const life = 1400 + hash(i, 1, 105) * 1200
      const p = ((t + hash(i, 2, 105) * life) % life) / life
      const x = Math.floor(hash(i, 3, 105) * w + Math.sin(p * 6 + i) * 1.5)
      const y = Math.floor((1 - p) * h * 0.9)
      if (x >= 0 && x < w && y >= 0 && y < h && heat[y * w + x] < MAX * 0.4) out[y * w + x] = p < 0.6 ? 0xffb347 : 0xc05020
    }
    return out
  }
}

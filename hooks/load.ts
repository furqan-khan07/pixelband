/**
 * Getting an image off disk and into RGBA.
 *
 * PNG and BMP decode right here in the mod. Everything else people actually have (JPEG, HEIC from
 * an iPhone, WebP, GIF) goes through the OS: `sips` ships with every Mac, ImageMagick is common on
 * Linux. They also shrink the photo on the way, so we never pull a 12-megapixel image into the mod.
 */
import { decodeBmp, isBmp } from './bmp'
import { decodePng, isPng, type Rgba } from './png'

/** How big an image we decode ourselves before handing it to the OS tool to shrink first. */
const MAX_DIRECT_PIXELS = 1024 * 1024
/** Longest side we ask the OS tool for. The band is tiny; this is plenty. */
const TOOL_MAX_SIDE = 256

export interface Loaded { image: Rgba; via: string }

/**
 * What loading needs from Claude Code. Passed as plain functions because a mod may not hand `$`
 * around: every engine call is written out as `$.noun.event(...)` where it happens (register.ts).
 */
export interface Io {
  readBase64: (path: string) => Promise<unknown>
  tmpdir: () => Promise<unknown>
  run: (argv: string[]) => Promise<unknown>
}

/**
 * Tidy up a path the way people actually give it: quoted, with backslash-escaped spaces from
 * dragging a file into the terminal, or starting with `~`.
 */
export function cleanPath(input: string, home?: string): string {
  let p = input.trim()
  if (p.length > 1 && ((p[0] === '"' && p.endsWith('"')) || (p[0] === "'" && p.endsWith("'")))) p = p.slice(1, -1)
  p = p.replace(/\\(.)/g, '$1')
  if (home && (p === '~' || p.startsWith('~/'))) p = home.replace(/\/$/, '') + p.slice(1)
  return p
}

async function readBytes(io: Io, path: string): Promise<Uint8Array> {
  const r = (await io.readBase64(path)) as { base64?: unknown } | undefined
  if (r && typeof r === 'object' && typeof r.base64 === 'string') return Uint8Array.fromBase64(r.base64)
  throw new Error(`unexpected read result: ${JSON.stringify(r)?.slice(0, 120)}`)
}

function pngPixels(b: Uint8Array): number {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  return u32(16) * u32(20)
}

/** Ask sips, then ImageMagick, to turn `path` into a small BMP we can read. */
async function viaTool(io: Io, path: string): Promise<Loaded> {
  const tmp = String((await io.tmpdir()) || '/tmp').replace(/\/$/, '')
  const out = `${tmp}/pixelband-${Math.random().toString(36).slice(2)}.bmp`
  const attempts: [string, string[]][] = [
    ['sips', ['sips', '-s', 'format', 'bmp', '--resampleHeightWidthMax', String(TOOL_MAX_SIDE), path, '--out', out]],
    ['magick', ['magick', path, '-resize', `${TOOL_MAX_SIDE}x${TOOL_MAX_SIDE}>`, `BMP3:${out}`]],
    ['convert', ['convert', path, '-resize', `${TOOL_MAX_SIDE}x${TOOL_MAX_SIDE}>`, `BMP3:${out}`]],
  ]
  for (const [name, argv] of attempts) {
    try {
      const res = (await io.run(argv)) as { exitCode?: number } | undefined
      if (!res || res.exitCode !== 0) continue
      return { image: decodeBmp(await readBytes(io, out)), via: name }
    } catch {
      continue
    } finally {
      try { await io.run(['rm', '-f', out]) } catch { /* best effort */ }
    }
  }
  throw new Error("I can read PNG and BMP myself; for other formats I need macOS's sips or ImageMagick, and neither worked. Try a PNG?")
}

/** Photo formats go straight to the OS tool: no point pulling a 20 MB HEIC through the mod. */
const TOOL_FIRST = /\.(jpe?g|heic|heif|webp|gif|tiff?|avif|icns|psd)$/i

/** Load any image we can into RGBA. */
export async function loadImage(io: Io, path: string): Promise<Loaded> {
  let toolError: unknown = null
  if (TOOL_FIRST.test(path)) {
    try { return await viaTool(io, path) } catch (err) { toolError = err } // maybe it's a mislabelled PNG
  }
  let bytes: Uint8Array
  try {
    bytes = await readBytes(io, path)
  } catch (err: any) {
    const why = err?.message ?? String(err)
    throw new Error(`couldn't read ${path}${why ? ` (${why})` : ''}`)
  }
  if (isPng(bytes)) {
    // Small PNGs decode here; huge ones get shrunk by the OS tool first when there is one.
    if (pngPixels(bytes) <= MAX_DIRECT_PIXELS) {
      try { return { image: decodePng(bytes), via: 'png' } } catch { /* e.g. interlaced: try the tool */ }
    }
    try { return await viaTool(io, path) } catch { return { image: decodePng(bytes), via: 'png' } }
  }
  if (isBmp(bytes)) {
    try { return { image: decodeBmp(bytes), via: 'bmp' } } catch { /* odd BMP: try the tool */ }
  }
  if (toolError) throw toolError
  return viaTool(io, path)
}

/**
 * pixelband: pixel art above the Claude Code prompt that reacts while Claude works.
 *
 *   /pixelband set <image> [--here]   use an image (drag a file into the terminal for the path);
 *                                     --here makes it this project's banner only
 *   /pixelband style <name>           original, gameboy, pico8, mono or sepia
 *   /pixelband layout <mode>          banner (full width, cropped), fit (whole image), or auto
 *   /pixelband move <dir> [n]         aim the banner's crop: up, down, left, right
 *   /pixelband zoom <in|out|reset>    crop tighter or wider
 *   /pixelband size <rows>            how tall the band is (2-24 rows, two pixels per row)
 *   /pixelband colors <n>             palette size (2-32) for the original and sepia styles
 *   /pixelband on | off               show or hide it
 *   /pixelband clear [--here]         forget the image
 *   /pixelband demo <mood>            play working, done, error or intro (handy for screenshots)
 *
 * How it hangs together: the band is drawn by hooking `ui.render` for `AbovePrompt` with one Raster
 * element. Turn events set a mood; while a mood is animating, a clock timer asks effects.ts for the
 * next frame and swaps it into the Raster with `$.ui.blit`, so nothing else redraws.
 */
import type { Register } from 'claude-code'
import { DURATION, FRAME_MS, frame, isOneShot, type Mood } from './effects'
import { cleanPath, loadImage, type Io } from './load'
import { cropRect, DEFAULT_VIEW, downscale, downscaleRegion, fit, shrinkToFit, transparency, TRANSPARENT, type Art, type View } from './pixelate'
import type { Rgba } from './png'
import { cellsFor, rowsFor } from './raster'
import { STYLES, stylize, type Style } from './styles'

type Layout = 'auto' | 'banner' | 'fit'
interface Config { rows: number; colors: number; enabled: boolean; style: Style; layout: Layout }
/** The image as kept in the store: RGB when it's fully opaque (a quarter smaller), RGBA otherwise. */
interface StoredImage { w: number; h: number; rgb?: string; rgba?: string; name: string }

const DEFAULTS: Config = { rows: 12, colors: 16, enabled: true, style: 'original', layout: 'auto' }
/** Longest side of the copy we keep; wide enough for a full-width banner. The store caps at 4 MiB total. */
const STORED_MAX_SIDE = 320
const MAX_COLS = 250
/** Upper bound on cells per drawing, so a huge terminal can't produce an unreasonably big frame. */
const MAX_CELLS = 6000
/** Images at least this see-through (logos, sprites) default to showing whole instead of cropped. */
const FIT_IF_TRANSPARENT = 0.15
const MOVE_STEP = 0.08
const KEY = 'art'

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

/**
 * The engine calls the band needs outside a hook's own `$` (the animation timer runs later).
 * A mod may not keep `$` itself, so session.start captures each call as a small function, the way
 * Anthropic's own diff mod does.
 */
interface Host {
  every: (ms: number, fn: () => void) => { cancel: () => void }
  after: (ms: number, fn: () => void) => unknown
  blit: (args: { requestId: string; key: string; cells: string; columns: number; rows: number }) => unknown
  invalidate: () => unknown
  get: (key: string) => Promise<unknown>
}

export const register: Register = (on) => {
  let host: Host | null = null
  let root = ''
  let config: Config = { ...DEFAULTS }
  let image: Rgba | null = null
  let imageName = ''
  let imageScope: 'project' | 'global' | null = null
  let imageClear = 0
  let view: View = { ...DEFAULT_VIEW }
  /** Whether the saved image has been looked up yet, so the "no image" hint doesn't flash at startup. */
  let ready = false

  let art: Art | null = null
  let artKey = ''
  /** Where the Raster is mounted, so the timer can blit frames into it. */
  let band: { requestId: string; columns: number; rows: number } | null = null

  let mood: Mood = 'idle'
  let ticks = 0
  let working = false
  let timer: { cancel: () => void } | null = null

  const projectKey = () => `image:${root}`

  const imageKeyFor = (scope: 'project' | 'global') => (scope === 'project' ? projectKey() : 'image:global')
  const viewKey = () => `view:${imageScope === 'project' ? root : 'global'}`

  function encodeStored(img: Rgba, name: string): StoredImage {
    if (transparency(img) > 0) return { w: img.width, h: img.height, rgba: img.data.toBase64(), name }
    const rgb = new Uint8Array(img.width * img.height * 3)
    for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) { rgb[j] = img.data[i]; rgb[j + 1] = img.data[i + 1]; rgb[j + 2] = img.data[i + 2] }
    return { w: img.width, h: img.height, rgb: rgb.toBase64(), name }
  }

  function decodeStored(s: StoredImage | undefined): Rgba | null {
    if (!s) return null
    if (typeof s.rgba === 'string') return { width: s.w, height: s.h, data: Uint8Array.fromBase64(s.rgba) }
    if (typeof s.rgb !== 'string') return null
    const rgb = Uint8Array.fromBase64(s.rgb)
    const data = new Uint8Array(s.w * s.h * 4)
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { data[i] = rgb[j]; data[i + 1] = rgb[j + 1]; data[i + 2] = rgb[j + 2]; data[i + 3] = 255 }
    return { width: s.w, height: s.h, data }
  }

  async function loadState() {
    if (!host) return
    const c = (await host.get('config')) as Partial<Config> | undefined
    config = { ...DEFAULTS, ...(c ?? {}) }
    const project = (await host.get(projectKey())) as StoredImage | undefined
    const global = (await host.get('image:global')) as StoredImage | undefined
    const pick = project ?? global
    image = decodeStored(pick)
    imageName = pick?.name ?? ''
    imageScope = project ? 'project' : global ? 'global' : null
    imageClear = image ? transparency(image) : 0
    const v = imageScope ? ((await host.get(viewKey())) as Partial<View> | undefined) : undefined
    view = { ...DEFAULT_VIEW, ...(v ?? {}) }
    art = null
  }

  const redraw = () => { try { host?.invalidate() } catch { /* not mounted yet */ } }

  const layoutOf = (): 'banner' | 'fit' =>
    config.layout === 'auto' ? (imageClear >= FIT_IF_TRANSPARENT ? 'fit' : 'banner') : config.layout

  /**
   * The art for a band `cols` wide and `rows` tall, re-made only when something that shapes it
   * changes. A banner fills the whole width with a crop of the image; fit shows all of it, centred.
   */
  function artFor(rows: number, cols: number): Art | null {
    if (!image) return null
    const layout = layoutOf()
    const key = `${layout}|${cols}x${rows}|${config.style}|${config.colors}|${view.focusX},${view.focusY},${view.zoom}`
    if (art && artKey === key) return art
    const w = cols, h = rows * 2
    if (layout === 'banner') {
      art = stylize(downscaleRegion(image, cropRect(image.width, image.height, w / h, view), w, h), config.style, config.colors)
    } else {
      const f = fit(image.width, image.height, rows, cols)
      const inner = stylize(downscale(image, f.w, f.h), config.style, config.colors)
      const px = new Uint32Array(w * f.h).fill(TRANSPARENT)
      const left = Math.floor((w - f.w) / 2)
      for (let y = 0; y < f.h; y++) px.set(inner.px.subarray(y * f.w, (y + 1) * f.w), y * w + left)
      art = { w, h: f.h, px }
    }
    artKey = key
    return art
  }

  function currentCells(): string | null {
    if (!art) return null
    return cellsFor(art, frame(art, mood, ticks * FRAME_MS))
  }

  function blit() {
    if (!band || !host) return
    const cells = currentCells()
    if (!cells) return
    Promise.resolve(host.blit({ requestId: band.requestId, key: KEY, cells, columns: band.columns, rows: band.rows }))
      .catch(() => { /* band gone or resized: the next render fixes it */ })
  }

  function stopTimer() { timer?.cancel(); timer = null }

  function tick() {
    ticks++
    if (isOneShot(mood) && ticks * FRAME_MS >= DURATION[mood]) setMood(working ? 'working' : 'idle')
    else blit()
  }

  function setMood(next: Mood) {
    mood = next
    ticks = 0
    if (next === 'idle') {
      stopTimer()
    } else if (!timer && host) {
      timer = host.every(FRAME_MS, tick)
    }
    blit()
  }

  on('session.start', async ($, e, next) => {
    host = {
      every: (ms, fn) => $.clock.every(ms, fn),
      after: (ms, fn) => $.clock.after(ms, fn),
      blit: (args) => $.ui.blit(args),
      invalidate: () => $.ui.invalidate('ui.render'),
      get: (key) => $.store.get(key),
    }
    root = (e as any).cwd ?? ''
    try { root = (await $.session.root()) || root } catch { /* not in a repo: cwd will do */ }
    await loadState()
    ready = true
    redraw()
    await $.command.register({
      name: 'pixelband',
      description: 'Pixel art above your prompt: set <image> [--here], style, layout, move, zoom, size, colors, on, off, clear, demo',
      argumentHint: 'set <image> | style <name> | layout <mode> | move <dir> | zoom <in|out> | size <rows> | on | off',
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (!(e as any).agentId) { working = true; if (mood !== 'working') setMood('working') }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!(e as any).agentId) {
      working = false
      const reason = (e as any).reason
      setMood(reason === 'answer' ? 'done' : reason === 'error' || reason === 'refusal' ? 'error' : 'idle')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const props = (e as any).props
    if (!config.enabled || props.hasSurvey) return next(e)
    const { Box, Text, Raster } = $.ui.resolve(e) as any
    if (!image) {
      band = null
      if (!ready) return next(e)
      return h(Text, { dimColor: true }, 'pixelband · /pixelband set <path to an image> to put pixel art here')
    }
    const cols = Math.max(1, Math.min(props.bodyColumns ?? 80, MAX_COLS))
    const rows = Math.min(config.rows, props.maxRows ?? config.rows, Math.floor(MAX_CELLS / cols))
    if (rows < 1) return next(e)
    const a = artFor(rows, cols)
    if (!a) return next(e)

    // Catch up if a turn event was missed.
    if (props.isWorking && mood === 'idle') { working = true; setMood('working') }
    if (!props.isWorking && mood === 'working') { working = false; setMood('idle') }

    band = { requestId: (e as any).requestId, columns: a.w, rows: rowsFor(a.h) }
    return h(Box, { flexDirection: 'row' },
      h(Raster, { key: KEY, columns: band.columns, rows: band.rows, cells: currentCells() }))
  })

  on('command.run', { command: 'pixelband' }, async ($, e, next) => {
    const io: Io = {
      readBase64: (path) => $.fs.read(path, { as: 'bytes' }),
      tmpdir: () => $.env.get('TMPDIR'),
      run: (argv) => $.process.run(argv),
    }
    const args = String((e as any).args ?? '').trim()
    const [sub, ...rest] = args.split(/\s+/)
    const tail = args.slice(sub.length).trim()
    const here = /(^|\s)--here$/.test(tail)
    const arg = tail.replace(/(^|\s)--here$/, '').trim()

    const save = async () => { await $.store.set('config', config); art = null; redraw() }
    const saveView = async () => { await $.store.set(viewKey(), view); art = null; redraw() }

    switch ((sub || '').toLowerCase()) {
      case 'set': {
        if (!arg) return { text: 'Usage: /pixelband set <path to an image> [--here]. Tip: drag the file into the terminal.' }
        const path = cleanPath(arg, (await $.env.get('HOME')) as string | undefined)
        let loaded
        try { loaded = await loadImage(io, path) } catch (err: any) { return { text: `${err?.message ?? err}` } }
        const kept = shrinkToFit(loaded.image, STORED_MAX_SIDE)
        const name = path.split('/').pop() || path
        const scope = here ? 'project' : 'global'
        const put = (await $.store.set(imageKeyFor(scope), encodeStored(kept, name))) as { deny?: string } | undefined
        if (put && put.deny) return { text: `couldn't save it (${put.deny}). Try /pixelband clear on banners you no longer use.` }
        image = kept; imageName = name; imageScope = scope; imageClear = transparency(kept)
        view = { ...DEFAULT_VIEW }
        await $.store.set(viewKey(), view)
        art = null
        if (!config.enabled) { config.enabled = true; await $.store.set('config', config) }
        redraw()
        setMood('intro')
        return { text: `${name} is now ${here ? "this project's" : 'your'} banner (${loaded.image.width}x${loaded.image.height}, read via ${loaded.via}).` }
      }
      case 'size': {
        const n = Number(arg)
        if (!Number.isFinite(n)) return { text: 'Usage: /pixelband size <rows>, from 2 to 24.' }
        config.rows = clampInt(n, 2, 24); await save()
        return { text: `${config.rows} rows tall (${config.rows * 2} pixels), as much as the terminal allows.` }
      }
      case 'style': {
        const name = arg.toLowerCase() as Style
        if (!STYLES.includes(name)) return { text: `Usage: /pixelband style ${STYLES.join('|')}` }
        config.style = name; await save()
        return { text: `style: ${name}.` }
      }
      case 'layout': {
        const mode = arg.toLowerCase() as Layout
        if (!['auto', 'banner', 'fit'].includes(mode)) return { text: 'Usage: /pixelband layout banner|fit|auto' }
        config.layout = mode; await save()
        return { text: `layout: ${mode}${mode === 'auto' ? ` (${layoutOf()} for this image)` : ''}.` }
      }
      case 'move': {
        const [dir, count] = arg.toLowerCase().split(/\s+/)
        const n = Math.max(1, Math.min(10, Number(count) || 1)) * MOVE_STEP
        const d = ({ up: [0, -n], down: [0, n], left: [-n, 0], right: [n, 0] } as Record<string, number[]>)[dir]
        if (!d) return { text: 'Usage: /pixelband move up|down|left|right [steps]' }
        view = { ...view, focusX: Math.min(1, Math.max(0, view.focusX + d[0])), focusY: Math.min(1, Math.max(0, view.focusY + d[1])) }
        await saveView()
        return { text: `crop centred at ${Math.round(view.focusX * 100)}% across, ${Math.round(view.focusY * 100)}% down.` }
      }
      case 'zoom': {
        const how = arg.toLowerCase()
        if (!['in', 'out', 'reset'].includes(how)) return { text: 'Usage: /pixelband zoom in|out|reset' }
        const zoom = how === 'reset' ? 1 : Math.min(4, Math.max(1, view.zoom * (how === 'in' ? 1.25 : 0.8)))
        view = how === 'reset' ? { ...DEFAULT_VIEW } : { ...view, zoom: Math.round(zoom * 100) / 100 }
        await saveView()
        return { text: `zoom ${view.zoom}x.` }
      }
      case 'colors':
      case 'colours': {
        const n = Number(arg)
        if (!Number.isFinite(n)) return { text: 'Usage: /pixelband colors <n>, from 2 to 32.' }
        config.colors = clampInt(n, 2, 32); await save()
        return { text: `${config.colors}-colour palette.` }
      }
      case 'on':
      case 'off':
        config.enabled = sub.toLowerCase() === 'on'; await save()
        return { text: `${config.enabled ? 'on' : 'off'}.` }
      case 'clear': {
        await $.store.delete(here ? projectKey() : 'image:global')
        await loadState(); redraw()
        return { text: `cleared ${here ? "this project's" : 'the global'} image.` }
      }
      case 'demo': {
        const m = arg.toLowerCase()
        if (!['working', 'done', 'error', 'intro'].includes(m)) return { text: 'Usage: /pixelband demo working|done|error|intro' }
        if (!image) return { text: 'set an image first (/pixelband set <path>).' }
        working = false
        setMood(m as Mood)
        // A demo "working" has no turn to end it, so stop it after a few seconds.
        if (m === 'working') $.clock.after(3000, () => { if (mood === 'working' && !working) setMood('idle') })
        return { text: `playing ${m}.` }
      }
      default: {
        const status = image
          ? `showing ${imageName} (${imageScope === 'project' ? 'this project' : 'global'}), ${layoutOf()}, ${config.style}, ${config.rows} rows, ${config.enabled ? 'on' : 'off'}`
          : 'no image yet'
        return { text: `${status}.\nCommands: set <image> [--here] · style <${STYLES.join('|')}> · layout <banner|fit|auto> · move <up|down|left|right> · zoom <in|out|reset> · size <rows> · colors <n> · on · off · clear [--here] · demo <working|done|error|intro>` }
      }
    }
  })
}

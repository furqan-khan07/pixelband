/**
 * pixelband: pixel art above the Claude Code prompt that reacts while Claude works.
 *
 *   /pixelband set <image> [--here]   use an image (drag a file into the terminal for the path);
 *                                     --here makes it this project's banner only
 *   /pixelband size <rows>            how tall the band is (2-16 rows, two pixels per row)
 *   /pixelband colors <n>             palette size (2-32); fewer colours reads more "pixel art"
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
import { fit, pixelate, shrinkToFit, type Art } from './pixelate'
import type { Rgba } from './png'
import { cellsFor, rowsFor } from './raster'

interface Config { rows: number; colors: number; enabled: boolean }
interface StoredImage { w: number; h: number; rgba: string; name: string }

const DEFAULTS: Config = { rows: 6, colors: 16, enabled: true }
/** Longest side of the copy we keep in the store; resizing later re-pixelates from this. */
const STORED_MAX_SIDE = 128
const MAX_COLS = 120
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

  let art: Art | null = null
  let artKey = ''
  /** Where the Raster is mounted, so the timer can blit frames into it. */
  let band: { requestId: string; columns: number; rows: number } | null = null

  let mood: Mood = 'idle'
  let ticks = 0
  let working = false
  let timer: { cancel: () => void } | null = null

  const projectKey = () => `image:${root}`

  function decodeStored(s: StoredImage | undefined): Rgba | null {
    if (!s || typeof s.rgba !== 'string') return null
    return { width: s.w, height: s.h, data: Uint8Array.fromBase64(s.rgba) }
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
    art = null
  }

  const redraw = () => { try { host?.invalidate() } catch { /* not mounted yet */ } }

  /** The art for the band's current size, re-pixelated only when size or palette changes. */
  function artFor(rows: number, maxCols: number): Art | null {
    if (!image) return null
    const { w, h } = fit(image.width, image.height, rows, maxCols)
    const key = `${w}x${h}x${config.colors}`
    if (art && artKey === key) return art
    art = pixelate(image, w, h, config.colors)
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
    await $.command.register({
      name: 'pixelband',
      description: 'Pixel art above your prompt: set <image> [--here], size <rows>, colors <n>, on, off, clear, demo <mood>',
      argumentHint: 'set <image> | size <rows> | colors <n> | on | off | clear | demo <mood>',
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
      return h(Text, { dimColor: true }, 'pixelband · /pixelband set <path to an image> to put pixel art here')
    }
    const rows = Math.min(config.rows, props.maxRows ?? config.rows)
    if (rows < 1) return next(e)
    const a = artFor(rows, Math.min(props.bodyColumns ?? MAX_COLS, MAX_COLS))
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

    switch ((sub || '').toLowerCase()) {
      case 'set': {
        if (!arg) return { text: 'Usage: /pixelband set <path to an image> [--here]. Tip: drag the file into the terminal.' }
        const path = cleanPath(arg, (await $.env.get('HOME')) as string | undefined)
        let loaded
        try { loaded = await loadImage(io, path) } catch (err: any) { return { text: `${err?.message ?? err}` } }
        const kept = shrinkToFit(loaded.image, STORED_MAX_SIDE)
        const name = path.split('/').pop() || path
        const stored: StoredImage = { w: kept.width, h: kept.height, rgba: kept.data.toBase64(), name }
        await $.store.set(here ? projectKey() : 'image:global', stored)
        image = kept; imageName = name; imageScope = here ? 'project' : 'global'
        art = null
        if (!config.enabled) { config.enabled = true; await $.store.set('config', config) }
        redraw()
        setMood('intro')
        return { text: `${name} is now ${here ? "this project's" : 'your'} banner (${loaded.image.width}x${loaded.image.height}, read via ${loaded.via}).` }
      }
      case 'size': {
        const n = Number(arg)
        if (!Number.isFinite(n)) return { text: 'Usage: /pixelband size <rows>, from 2 to 16.' }
        config.rows = clampInt(n, 2, 16); await save()
        return { text: `${config.rows} rows tall (${config.rows * 2} pixels).` }
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
          ? `showing ${imageName} (${imageScope === 'project' ? 'this project' : 'global'}), ${config.rows} rows, ${config.colors} colours, ${config.enabled ? 'on' : 'off'}`
          : 'no image yet'
        return { text: `${status}.\nCommands: set <image> [--here] · size <rows> · colors <n> · on · off · clear [--here] · demo <working|done|error|intro>` }
      }
    }
  })
}

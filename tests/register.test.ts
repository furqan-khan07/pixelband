import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { IMAGES } from './fixtures/images'

tier('user')

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const band = (isWorking = false, maxRows = 10) => ({
  plugin: 'pixelband', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking, maxRows, bodyColumns: 80 },
}) as const

/** Everything beneath the mod: store, env, clock, files, and a record of every frame blitted. */
function world(on: any, files: Record<string, string> = {}) {
  const blits: any[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work' }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.blit', ($: any, e: any) => { blits.push(e); return { value: undefined } })
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: { base64: files[e.path] } } : { deny: 'no such file' }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not installed' } }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  // What Claude Code itself draws in the band: nothing, which we stand in for with a marker.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'core') })
  mock.store(on)
  mock.env(on, { HOME: '/Users/me', TMPDIR: '/tmp' })
  const clock = mock.clock(on)
  return { blits, clock }
}

const pix = (args: string) => ({ command: 'pixelband', args })
const complete = (reason: string) => ({ answer: 'x', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })

describe('register', () => {
  test('before an image is set, the band says how to set one', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const ui = await $.ui.mount(band())
    expect((await ui.find({ type: 'Text', text: /pixelband set/ }))).toBeDefined()
    await ui.unmount()
  })

  test('/pixelband set loads the image and the band draws it as pixel art', async ($, on) => {
    world(on, { '/Users/me/art.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    const r: any = await $.command.run(pix('set ~/art.png'))
    expect(r.text).toMatch(/^art\.png is now your banner/)  // no 'pixelband:' prefix: Claude Code adds the plugin's name itself
    const ui = await $.ui.mount(band())
    const art = await ui.find({ key: 'art' })
    expect(art?.type).toBe('Raster')
    expect(art?.props.rows).toBe(10)      // default 12 rows, capped by the 10 the band is given
    expect(art?.props.columns).toBe(80)   // the whole width of the band
    await ui.unmount()
  })

  test('a bad path gets a friendly message', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const r: any = await $.command.run(pix('set /nope.png'))
    expect(r.text).toMatch(/couldn't read \/nope\.png/)
  })

  test('the intro plays, then the animation stops by itself', async ($, on) => {
    const w = world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /a.png'))
    const ui = await $.ui.mount(band())
    await w.clock.advance(1000)
    const played = w.blits.length
    expect(played).toBeGreaterThan(3)
    await w.clock.advance(2000)
    expect(w.blits.length).toBe(played)   // idle: no timer running, no frames
    await ui.unmount()
  })

  test('turns drive the moods: light sweeps while working, then settles', async ($, on) => {
    const w = world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /a.png'))
    const ui = await $.ui.mount(band())
    await w.clock.advance(1000)            // let the intro finish
    const idleCells = w.blits[w.blits.length - 1].cells // the frame the intro settled on: the art itself

    await $.turn.start({ text: 'go', turnId: 't1' })
    const before = w.blits.length
    await w.clock.advance(800)
    const working = w.blits.slice(before)
    expect(working.length).toBeGreaterThan(5)
    expect(working.some((b) => b.cells !== idleCells)).toBe(true)

    await $.turn.complete(complete('answer'))
    const atAnswer = w.blits.length
    await w.clock.advance(200)
    expect(w.blits.slice(atAnswer).some((b) => b.cells !== idleCells && b.cells !== working[working.length - 1].cells),
      'a finished turn plays the done flash').toBe(true)
    await w.clock.advance(1800)
    const settled = w.blits.length
    await w.clock.advance(1000)
    expect(w.blits.length).toBe(settled)
    expect(w.blits[w.blits.length - 1].cells).toBe(idleCells) // back to the art exactly
    await ui.unmount()
  })

  test('an errored turn glitches and still settles back', async ($, on) => {
    const w = world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /a.png'))
    const ui = await $.ui.mount(band())
    await w.clock.advance(1000)
    const idleCells = w.blits[w.blits.length - 1].cells
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(complete('error'))
    const before = w.blits.length
    await w.clock.advance(200)
    expect(w.blits.slice(before).some((b) => b.cells !== idleCells)).toBe(true)
    await w.clock.advance(3000)
    expect(w.blits[w.blits.length - 1].cells).toBe(idleCells)
    await ui.unmount()
  })

  test('size and colours change the art; off hides the band and on brings it back', async ($, on) => {
    world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /a.png'))
    expect(((await $.command.run(pix('size 3'))) as any).text).toMatch(/3 rows/)
    let ui = await $.ui.mount(band())
    expect((await ui.find({ key: 'art' }))?.props.rows).toBe(3)
    await ui.unmount()

    await $.command.run(pix('off'))
    ui = await $.ui.mount(band())
    expect(await ui.find({ key: 'art' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'core' })).toBeDefined()
    await ui.unmount()

    await $.command.run(pix('on'))
    ui = await $.ui.mount(band())
    expect(await ui.find({ key: 'art' })).toBeDefined()
    await ui.unmount()
  })

  test('the band never takes more rows than Claude Code gives it', async ($, on) => {
    world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /a.png'))
    const ui = await $.ui.mount(band(false, 4))
    expect((await ui.find({ key: 'art' }))?.props.rows).toBeLessThanOrEqual(4)
    await ui.unmount()
  })

  test('--here makes it this project\'s banner; clear forgets it', async ($, on) => {
    world(on, { '/a.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    expect(((await $.command.run(pix('set /a.png --here'))) as any).text).toMatch(/this project's banner/)
    expect(((await $.command.run(pix(''))) as any).text).toMatch(/showing a\.png \(this project\)/)
    await $.command.run(pix('clear --here'))
    const ui = await $.ui.mount(band())
    expect(await ui.find({ type: 'Text', text: /pixelband set/ })).toBeDefined()
    await ui.unmount()
  })

  test('with no arguments it shows status and the commands', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    expect(((await $.command.run(pix(''))) as any).text).toMatch(/no image yet[\s\S]*set <image>/)
  })
})

const cellsOf = (b64: string) => Array.from(new Uint32Array(Uint8Array.fromBase64(b64).buffer))

describe('layout', () => {
  test('an opaque image fills the band as a full-width banner', async ($, on) => {
    const w = world(on, { '/photo.png': IMAGES.rgb8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /photo.png'))
    await w.clock.advance(1000)            // let the intro finish
    expect(((await $.command.run(pix(''))) as any).text).toMatch(/, banner, original,/)
    const ui = await $.ui.mount(band())
    const art = await ui.find({ key: 'art' })
    expect([art?.props.columns, art?.props.rows]).toEqual([80, 10])
    const cells = cellsOf(art?.props.cells as string)
    expect(cells[0]).not.toBe(0x20)                               // no empty margin: it starts at the left edge
    await ui.unmount()
  })

  test('a see-through image (logo, sprite) shows whole and centred instead', async ($, on) => {
    world(on, { '/logo.png': IMAGES.rgba8.png! })   // a quarter of its pixels are transparent
    await $.session.start(SESSION)
    await $.command.run(pix('set /logo.png'))
    expect(((await $.command.run(pix(''))) as any).text).toMatch(/, fit, /)
    const ui = await $.ui.mount(band())
    const cells = cellsOf((await ui.find({ key: 'art' }))?.props.cells as string)
    expect(cells.slice(0, 3)).toEqual([0x20, 0x01000000, 0x01000000]) // empty margin on the left...
    const row = cells.slice(0, 80 * 3)
    expect(row.slice(-3)).toEqual([0x20, 0x01000000, 0x01000000])     // ...and on the right
    await ui.unmount()
  })

  test('layout can be forced either way', async ($, on) => {
    const w = world(on, { '/logo.png': IMAGES.rgba8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /logo.png'))
    await w.clock.advance(1000)            // let the intro finish
    expect(((await $.command.run(pix('layout banner'))) as any).text).toBe('layout: banner.')
    expect(((await $.command.run(pix('layout auto'))) as any).text).toBe('layout: auto (fit for this image).')
    expect(((await $.command.run(pix('layout sideways'))) as any).text).toMatch(/^Usage/)
  })

  test('styles change the art, and an unknown one gets the list', async ($, on) => {
    const w = world(on, { '/photo.png': IMAGES.rgb8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /photo.png'))
    await w.clock.advance(1000)            // let the intro finish
    const draw = async () => { const ui = await $.ui.mount(band()); const c = (await ui.find({ key: 'art' }))?.props.cells; await ui.unmount(); return c }
    const original = await draw()
    expect(((await $.command.run(pix('style gameboy'))) as any).text).toBe('style: gameboy.')
    expect(await draw()).not.toBe(original)
    expect(((await $.command.run(pix('style vaporwave'))) as any).text).toMatch(/original\|gameboy\|pico8\|mono\|sepia/)
  })

  test('move and zoom aim the crop, and it is remembered', async ($, on) => {
    const w = world(on, { '/photo.png': IMAGES.rgb8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /photo.png'))
    await w.clock.advance(1000)            // let the intro finish
    const draw = async () => { const ui = await $.ui.mount(band()); const c = (await ui.find({ key: 'art' }))?.props.cells; await ui.unmount(); return c }
    const centred = await draw()
    expect(((await $.command.run(pix('zoom in'))) as any).text).toBe('zoom 1.25x.')
    expect(((await $.command.run(pix('move up 2'))) as any).text).toBe('crop centred at 50% across, 34% down.')
    const aimed = await draw()
    expect(aimed).not.toBe(centred)
    // a fresh session reads the same view back from the store
    await $.session.start(SESSION)
    expect(await draw()).toBe(aimed)
    expect(((await $.command.run(pix('zoom reset'))) as any).text).toBe('zoom 1x.')
    expect(await draw()).toBe(centred)
  })

  test('a huge terminal still gets a sensibly sized drawing', async ($, on) => {
    const w = world(on, { '/photo.png': IMAGES.rgb8.png! })
    await $.session.start(SESSION)
    await $.command.run(pix('set /photo.png'))
    await w.clock.advance(1000)            // let the intro finish
    await $.command.run(pix('size 24'))
    const ui = await $.ui.mount({ ...band(false, 60), props: { hasSurvey: false, isWorking: false, maxRows: 60, bodyColumns: 400 } })
    const art = await ui.find({ key: 'art' })
    expect(art?.props.columns).toBe(250)
    expect((art?.props.columns as number) * (art?.props.rows as number)).toBeLessThanOrEqual(6000)
    await ui.unmount()
  })
})

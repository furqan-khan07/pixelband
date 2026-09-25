import { describe, expect, test, tier } from 'claude-code/testing'
import { cleanPath, loadImage, type Io } from '../hooks/load'
import { IMAGES } from './fixtures/images'

tier('user')

/** A pretend filesystem and PATH: `tool` decides what running a program does. */
function fakeIo(files: Record<string, string>, tool?: (argv: string[]) => number) {
  const runs: string[][] = []
  const io: Io = {
    readBase64: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return { base64: files[p] } },
    tmpdir: async () => '/tmp/',
    run: async (argv) => {
      runs.push(argv)
      const code = argv[0] === 'rm' ? 0 : tool ? tool(argv) : 127
      if (code === 0 && argv[0] === 'sips') files[argv[argv.length - 1]] = IMAGES.sips_bmp.bmp!
      return { exitCode: code, stdout: '', stderr: '' }
    },
  }
  return { io, runs }
}

const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70))

describe('load', () => {
  test('cleanPath handles quotes, drag-and-drop escapes, and ~', async () => {
    expect(cleanPath('  "/a b/c.png" ')).toBe('/a b/c.png')
    expect(cleanPath('/Users/me/My\\ Pics/cat.png')).toBe('/Users/me/My Pics/cat.png')
    expect(cleanPath('~/cat.png', '/Users/me/')).toBe('/Users/me/cat.png')
    expect(cleanPath("'~/x.png'", '/h')).toBe('/h/x.png')
  })

  test('a PNG is decoded right here, without running anything', async () => {
    const { io, runs } = fakeIo({ '/a.png': IMAGES.rgba8.png! })
    const r = await loadImage(io, '/a.png')
    expect([r.via, r.image.width, r.image.height]).toEqual(['png', 7, 5])
    expect(runs).toEqual([])
  })

  test('a JPEG goes through sips, and the temp file is cleaned up', async () => {
    const { io, runs } = fakeIo({ '/photo.jpg': JPEG }, (argv) => (argv[0] === 'sips' ? 0 : 127))
    const r = await loadImage(io, '/photo.jpg')
    expect(r.via).toBe('sips')
    expect([r.image.width, r.image.height]).toEqual([IMAGES.sips_bmp.width, IMAGES.sips_bmp.height])
    expect(runs[0].slice(0, 5)).toEqual(['sips', '-s', 'format', 'bmp', '--resampleHeightWidthMax'])
    expect(runs[0][runs[0].length - 1].startsWith('/tmp/pixelband-')).toBe(true)
    expect(runs.some((a) => a[0] === 'rm')).toBe(true)
  })

  test('with no image tool, a non-PNG gets a clear message instead of a crash', async () => {
    const { io } = fakeIo({ '/photo.jpg': JPEG })
    await expect(loadImage(io, '/photo.jpg')).rejects.toThrow(/Try a PNG/)
  })

  test('a missing file says so', async () => {
    const { io } = fakeIo({})
    await expect(loadImage(io, '/nope.png')).rejects.toThrow(/couldn't read \/nope.png/)
  })

  test('an interlaced PNG falls back to the OS tool', async () => {
    const { io } = fakeIo({ '/i.png': IMAGES.interlaced.png! }, (argv) => (argv[0] === 'sips' ? 0 : 127))
    expect((await loadImage(io, '/i.png')).via).toBe('sips')
  })
})

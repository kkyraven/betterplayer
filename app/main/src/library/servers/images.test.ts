import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolBytes } from '../tools'
import { cacheImage, spriteCues } from './images'

const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
sprite.jpg#xywh=0,0,32,18

00:00:01.000 --> 00:00:02.000
sprite.jpg#xywh=32,0,32,18

00:00:02.000 --> 00:00:03.000
sprite.jpg#xywh=0,18,32,18

00:00:03.000 --> 00:00:04.000
sprite.jpg#xywh=32,18,32,18
`

describe('cached remote images', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bp-images-')) })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('maps VTT coordinates into twenty correctly ordered hover frames with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(vtt))
      .mockResolvedValueOnce(new Response(await readFile(join(__dirname, 'fixtures/sprite.jpg'))))
    vi.stubGlobal('fetch', fetchMock)
    const output = join(dir, 'strip.jpg')
    expect(await cacheImage(output, { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: 'https://stash/preview' }, { ApiKey: 'secret' }, 4000)).toMatch(/^[a-f0-9]{64}$/)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://stash/vtt', 'https://stash/sprite'])
    expect(fetchMock.mock.calls.every(([, options]) => options.headers.ApiKey === 'secret')).toBe(true)
    const pixels = await runToolBytes('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 30_000)
    expect(pixels.length).toBe(3200 * 90 * 3)
    const colors = [0, 5, 10, 15].map((frame) => [...pixels.subarray((45 * 3200 + frame * 160 + 80) * 3, (45 * 3200 + frame * 160 + 80) * 3 + 3)])
    for (const [index, expected] of [[250, 0, 0], [0, 250, 0], [0, 0, 250], [250, 250, 250]].entries()) {
      colors[index]!.forEach((channel, c) => expect(Math.abs(channel - expected[c]!)).toBeLessThan(15))
    }
    expect(await readdir(dir)).toEqual(['strip.jpg'])
  })

  it('rejects corrupt poster responses without replacing the cached image', async () => {
    const jpeg = await readFile(join(__dirname, 'fixtures/poster.jpg'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(jpeg)).mockResolvedValueOnce(new Response('<html>login</html>')))
    const output = join(dir, 'poster.jpg')
    await cacheImage(output, 'https://stash/screenshot', {})
    await expect(cacheImage(output, 'https://stash/screenshot', {})).rejects.toThrow()
    expect(await readFile(output)).toEqual(jpeg)
    expect(await readdir(dir)).toEqual(['poster.jpg'])
  })

  it('uses the generated video when sprites are absent and treats absent previews as optional', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(await readFile(join(__dirname, 'fixtures/preview.mp4'))))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: 'https://stash/preview' }
    const output = join(dir, 'strip.jpg')
    await cacheImage(output, source, { ApiKey: 'secret' })
    const pixels = await runToolBytes('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 30_000)
    expect(pixels.length).toBe(3200 * 90 * 3)
    expect(await cacheImage(join(dir, 'absent.jpg'), source, {})).toBeNull()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://stash/vtt', 'https://stash/preview', 'https://stash/vtt', 'https://stash/preview'])
    expect(await readdir(dir)).toEqual(['strip.jpg'])
  })

  it('rejects out-of-bounds sprite coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(vtt.replace('0,0,32,18', '100,0,32,18')))
      .mockResolvedValueOnce(new Response(await readFile(join(__dirname, 'fixtures/sprite.jpg')))))
    await expect(cacheImage(join(dir, 'strip.jpg'), { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: null }, {})).rejects.toThrow('sprite coordinates exceed image')
    expect(await readdir(dir)).toEqual([])
  })

  it('parses CRLF cues and rejects missing or unsafe coordinates', () => {
    expect(spriteCues(vtt.replace(/\n/g, '\r\n'))).toHaveLength(4)
    expect(() => spriteCues('WEBVTT')).toThrow('no sprite cues')
    expect(() => spriteCues(vtt.replace('0,0,32,18', '99999999999999999999,0,32,18'))).toThrow('invalid sprite cue')
  })
})

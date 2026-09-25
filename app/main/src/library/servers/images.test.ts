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
    expect(await cacheImage(output, { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: 'https://stash/preview' }, { ApiKey: 'secret' }, 4000)).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), validators: {} })
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
    expect(await cacheImage(join(dir, 'absent.jpg'), source, {})).toEqual({ digest: null, validators: {} })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://stash/vtt', 'https://stash/preview', 'https://stash/vtt', 'https://stash/preview'])
    expect(await readdir(dir)).toEqual(['strip.jpg'])
  })

  it('rejects out-of-bounds sprite coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(vtt.replace('0,0,32,18', '100,0,32,18')))
      .mockResolvedValueOnce(new Response(await readFile(join(__dirname, 'fixtures/sprite.jpg')))))
    await expect(cacheImage(join(dir, 'strip.jpg'), { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: null }, {})).rejects.toThrow('sprite coordinates exceed image')
    expect(await readdir(dir)).toEqual([])
  })

  it('asks whether each half of a sprite strip changed and refetches only the half that did', async () => {
    const sprite = await readFile(join(__dirname, 'fixtures/sprite.jpg'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(vtt, { headers: { ETag: '"vtt"' } }))
      .mockResolvedValueOnce(new Response(sprite, { headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(sprite, { headers: { 'Last-Modified': 'Tue, 02 Jan 2024 00:00:00 GMT' } }))
      .mockResolvedValueOnce(new Response(vtt))
    vi.stubGlobal('fetch', fetchMock)
    const source = { sprite: 'https://stash/sprite', vtt: 'https://stash/vtt', video: null }
    const output = join(dir, 'strip.jpg')
    const first = await cacheImage(output, source, {}, 4000)
    if (first === 'unchanged') throw new Error('first download reported unchanged')
    expect(first.validators).toEqual({ 'https://stash/vtt': { etag: '"vtt"' }, 'https://stash/sprite': { modified: 'Mon, 01 Jan 2024 00:00:00 GMT' } })
    expect(await cacheImage(output, source, {}, 4000, undefined, undefined, first.validators)).toBe('unchanged')
    expect(fetchMock.mock.calls.slice(2, 4).map(([, options]) => options.headers)).toEqual([{ 'If-None-Match': '"vtt"' }, { 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' }])
    const third = await cacheImage(output, source, {}, 4000, undefined, undefined, first.validators)
    expect(third).toEqual({ digest: first.digest, validators: { 'https://stash/sprite': { modified: 'Tue, 02 Jan 2024 00:00:00 GMT' } } })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://stash/vtt', 'https://stash/sprite', 'https://stash/vtt', 'https://stash/sprite', 'https://stash/vtt', 'https://stash/sprite', 'https://stash/vtt'])
    expect(fetchMock.mock.calls[6]![1].headers).toEqual({})
    expect(await readdir(dir)).toEqual(['strip.jpg'])
  })

  it('parses CRLF cues and rejects missing or unsafe coordinates', () => {
    expect(spriteCues(vtt.replace(/\n/g, '\r\n'))).toHaveLength(4)
    expect(() => spriteCues('WEBVTT')).toThrow('no sprite cues')
    expect(() => spriteCues(vtt.replace('0,0,32,18', '99999999999999999999,0,32,18'))).toThrow('invalid sprite cue')
  })
})

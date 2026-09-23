import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RunTool = (tool: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>
type ResolveUrl = (error: Error | null, stdout: string, stderr: string) => void
const mocks = vi.hoisted(() => ({ runTool: vi.fn<RunTool>(), execFile: vi.fn() }))
vi.mock('./library/tools', () => ({ runTool: mocks.runTool }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
import { Audio, BEAT_RATE } from './audio'

let root: string
let source: string
let audio: Audio
const samples = (args: string[], count = BEAT_RATE) => writeFileSync(args.at(-1)!, Buffer.alloc(count * 4))
const pending = () => {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'bp-audio-test-'))
  source = join(root, 'video.mp4')
  writeFileSync(source, 'source')
  audio = new Audio(root, '/yt-dlp')
  mocks.runTool.mockImplementation(async (_tool, args) => { samples(args); return '' })
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: { signal?: AbortSignal }, callback: ResolveUrl) => {
    queueMicrotask(() => callback(null, 'https://cdn.example/audio\n', ''))
  })
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('playback audio windows', () => {
  it('seeks before input, bounds the decode and reports the actual sample duration', async () => {
    const window = await audio.window(source, 90_000, 600_000, 'first')
    const [, args, timeout, signal] = mocks.runTool.mock.calls[0]!
    expect(args.slice(0, 9)).toEqual(['-y', '-v', 'error', '-ss', '90', '-i', source, '-t', '40'])
    expect(timeout).toBe(60_000)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(window).toMatchObject({ startMs: 90_000, endMs: 91_000 })
    expect(statSync(window.path).size).toBe(BEAT_RATE * 4)
    expect(await audio.window(source, 90_000, 600_000, 'cached')).toEqual(window)
    expect(mocks.runTool).toHaveBeenCalledTimes(1)
  })

  it('accepts empty audio and repairs invalid ranges without emitting a backwards interval', async () => {
    mocks.runTool.mockImplementation(async (_tool, args) => { samples(args, 0); return '' })
    expect(await audio.window(source, -100, NaN, 'empty')).toMatchObject({ startMs: 0, endMs: 0 })
    expect(mocks.runTool.mock.calls[0]?.[1]).toContain('40')
  })

  it('treats a missing audio stream as an empty window', async () => {
    mocks.runTool.mockRejectedValueOnce(new Error('ffmpeg exited with 1: Output file #0 does not contain any stream'))
    const window = await audio.window(source, 4000, 1000, 'no-audio')
    expect(window).toMatchObject({ startMs: 4000, endMs: 4000 })
    expect(readFileSync(window.path)).toHaveLength(0)
  })

  it('keys windows by source modification as well as offset and duration', async () => {
    const first = await audio.window(source, 0, 1000, 'first')
    const before = statSync(source)
    utimesSync(source, before.atime, new Date(before.mtimeMs + 10_000))
    const updated = await audio.window(source, 0, 1000, 'updated')
    const moved = await audio.window(source, 1000, 1000, 'moved')
    expect(new Set([first.path, updated.path, moved.path]).size).toBe(3)
    expect(mocks.runTool).toHaveBeenCalledTimes(3)
  })

  it('keeps only eight completed windows and never evicts the path just returned', async () => {
    for (let i = 0; i < 12; i++) {
      const window = await audio.window(source, i * 1000, 1000, `window-${i}`)
      expect(statSync(window.path).size).toBe(BEAT_RATE * 4)
    }
    expect(readdirSync(join(audio.dir, 'windows'))).toHaveLength(8)
  })

  it('aborts the matching decode, removes its partial file and leaves another request running', async () => {
    const wait = pending()
    mocks.runTool.mockImplementation((_tool, args, _timeout, signal) => {
      samples(args, 4)
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        void wait.promise.then(resolve)
      })
    })
    const old = audio.window(source, 0, 1000, 'old')
    const oldResult = old.catch((error: unknown) => error)
    await vi.waitFor(() => expect(mocks.runTool).toHaveBeenCalledTimes(1))
    audio.cancelWindow('old')
    expect(await oldResult).toMatchObject({ name: 'AbortError' })
    expect(readdirSync(join(audio.dir, 'windows'))).toEqual([])
    const next = audio.window(source, 1000, 1000, 'next')
    await vi.waitFor(() => expect(mocks.runTool).toHaveBeenCalledTimes(2))
    audio.cancelWindow('old')
    expect(mocks.runTool.mock.calls[1]?.[3]?.aborted).toBe(false)
    wait.resolve('')
    await expect(next).resolves.toMatchObject({ startMs: 1000 })
  })

  it('does not let an old completion remove the replacement request or publish its partial file', async () => {
    const first = pending()
    const second = pending()
    mocks.runTool.mockImplementationOnce((_tool, args) => { samples(args); return first.promise })
      .mockImplementationOnce((_tool, args) => { samples(args); return second.promise })
    const old = audio.window(source, 0, 1000, 'same').catch((error: unknown) => error)
    await vi.waitFor(() => expect(mocks.runTool).toHaveBeenCalledTimes(1))
    const replacement = audio.window(source, 1000, 1000, 'same').catch((error: unknown) => error)
    await vi.waitFor(() => expect(mocks.runTool).toHaveBeenCalledTimes(2))
    first.resolve('')
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(readdirSync(join(audio.dir, 'windows')).every((file) => file.endsWith('.tmp'))).toBe(true)
    audio.cancelWindow('same')
    expect(mocks.runTool.mock.calls[1]?.[3]?.aborted).toBe(true)
    second.resolve('')
    expect(await replacement).toMatchObject({ name: 'AbortError' })
    expect(readdirSync(join(audio.dir, 'windows'))).toEqual([])
  })

  it('caches URL resolution across windows and discards cancelled URL results', async () => {
    const url = 'https://example/video'
    await audio.window(url, 0, 1000, 'first')
    await audio.window(url, 1000, 1000, 'next')
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.runTool.mock.calls[1]?.[1]).toContain('https://cdn.example/audio')

    let finish!: ResolveUrl
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: { signal?: AbortSignal }, callback: ResolveUrl) => { finish = callback })
    const stale = audio.window('https://example/other', 0, 1000, 'stale').catch((error: unknown) => error)
    audio.cancelWindow('stale')
    finish(null, 'https://cdn.example/stale', '')
    expect(await stale).toMatchObject({ name: 'AbortError' })
    await audio.window('https://example/other', 0, 1000, 'fresh')
    expect(mocks.execFile).toHaveBeenCalledTimes(3)
    expect(mocks.runTool.mock.calls.at(-1)?.[1]).not.toContain('https://cdn.example/stale')
  })
})

describe('whole-file audio', () => {
  it('deduplicates concurrent decodes and exposes only a complete cache file', async () => {
    const wait = pending()
    mocks.runTool.mockImplementation((_tool, args) => { samples(args); return wait.promise })
    const first = audio.decode(source)
    await vi.waitFor(() => expect(mocks.runTool).toHaveBeenCalledTimes(1))
    const second = audio.decode(source)
    expect(readdirSync(audio.dir).filter((name) => name.endsWith('.f32'))).toEqual([])
    expect(mocks.runTool).toHaveBeenCalledTimes(1)
    wait.resolve('')
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(await audio.decode(source)).toBe(a)
    expect(mocks.runTool).toHaveBeenCalledTimes(1)
    expect(readdirSync(audio.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('removes a failed partial decode and retries instead of reusing it', async () => {
    mocks.runTool.mockImplementationOnce(async (_tool, args) => { samples(args); throw new Error('decode failed') })
    await expect(audio.decode(source)).rejects.toThrow('decode failed')
    expect(readdirSync(audio.dir)).toEqual(['windows'])
    const path = await audio.decode(source)
    expect(statSync(path).size).toBe(BEAT_RATE * 4)
    expect(mocks.runTool).toHaveBeenCalledTimes(2)
  })
})

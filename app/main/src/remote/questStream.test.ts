import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { frameSplitter, QuestStreams, readFacts, streamArgs, streamPlan, trackFrames, type Encode, type StreamFacts } from './questStream'

const facts = (codec: string, width: number, height: number, fps: number, mbps = 50): StreamFacts => ({ codec, width, height, fps, mbps })

describe('streamPlan', () => {
  it.each([
    ['H.264 7680x3840@60', facts('h264', 7680, 3840, 60), null],
    ['HEVC 8192x4096@30', facts('hevc', 8192, 4096, 30), null],
    ['AV1 7680x3840@60', facts('av1', 7680, 3840, 60), null],
    ['VP9 6144x3072@60', facts('vp9', 6144, 3072, 60), null],
    ['HEVC 8192x4096@60 scales to 7680x3840', facts('hevc', 8192, 4096, 60), { width: 7680, height: 3840, fps: 60, scale: true }],
    ['AV1 7680x3840@120 halves the rate', facts('av1', 7680, 3840, 120), { width: 7680, height: 3840, fps: 60, scale: false }],
    ['HEVC 5800x2900@120 halves the rate', facts('hevc', 5800, 2900, 120), { width: 5800, height: 2900, fps: 60, scale: false }],
    ['H.264 at 119.88 keeps NTSC', facts('h264', 7680, 3840, 120000 / 1001), { width: 7680, height: 3840, fps: 60000 / 1001, scale: false }],
    ['HEVC 8192x4096@100 halves to 50', facts('hevc', 8192, 4096, 100), { width: 8192, height: 4096, fps: 50, scale: false }],
    ['VP9 8192 wide', facts('vp9', 8192, 4096, 30), { width: 8192, height: 4096, fps: 30, scale: false }],
  ])('%s', (_name, input, plan) => {
    expect(streamPlan(input)).toEqual(plan)
  })

  it('re-encodes a file over its codec bitrate at its own size and rate', () => {
    expect(streamPlan(facts('av1', 5760, 2880, 60, 100))).toBeNull()
    expect(streamPlan(facts('av1', 5760, 2880, 60, 101))).toEqual({ width: 5760, height: 2880, fps: 60, scale: false })
  })

  it('re-encodes a codec it does not know, holding the rate to 60 when halving would not reach 48', () => {
    expect(streamPlan(facts('mpeg4', 1920, 1080, 30))).toEqual({ width: 1920, height: 1080, fps: 30, scale: false })
    expect(streamPlan(facts('prores', 3840, 2160, 90))).toEqual({ width: 3840, height: 2160, fps: 60, scale: false })
  })

  it('plays directly when the facts are unknown', () => {
    expect(streamPlan(facts('av1', 0, 0, 120))).toBeNull()
    expect(streamPlan(facts('av1', 7680, 3840, 0))).toBeNull()
  })
})

describe('readFacts', () => {
  it('reads the average rate, falling back to the stream rate', () => {
    expect(readFacts('{"streams":[{"codec_name":"av1","width":7680,"height":3840,"avg_frame_rate":"120/1","r_frame_rate":"120/1"}]}')).toEqual({ codec: 'av1', width: 7680, height: 3840, fps: 120 })
    expect(readFacts('{"streams":[{"codec_name":"hevc","width":10,"height":10,"avg_frame_rate":"0/0","r_frame_rate":"60000/1001"}]}')?.fps).toBeCloseTo(59.94, 2)
    expect(readFacts('{"streams":[]}')).toBeNull()
    expect(readFacts('not json')).toBeNull()
  })
})

describe('streamArgs', () => {
  it('seeks the input before opening it, and sizes on the GPU only when the plan scales', () => {
    const args = streamArgs('D:/v/a.mp4', 12_345, { width: 7680, height: 3840, fps: 60, scale: true })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('12.345')
    expect(args[args.indexOf('-i') + 1]).toBe('D:/v/a.mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[0:V:0]fps=60,split[e][t];[e]scale_cuda=7680:3840:format=p010le[v]')
    expect(args.slice(args.indexOf('pipe:1') - 2, args.indexOf('pipe:1') + 1)).toEqual(['-f', 'mpegts', 'pipe:1'])
    const same = streamArgs('a.mp4', 0, { width: 7680, height: 3840, fps: 60, scale: false })
    expect(same[same.indexOf('-filter_complex') + 1]).toContain('[e]scale_cuda=format=p010le[v]')
  })

  it("swaps the file's audio for the music, or drops it, when its estim audio is swapped", () => {
    const plan = { width: 7680, height: 3840, fps: 60, scale: false }
    const own = streamArgs('a.mp4', 5_000, plan)
    expect(own.filter((a) => a === '-i')).toHaveLength(1)
    expect(own).toContain('0:a:0?')
    const music = streamArgs('a.mp4', 5_000, plan, 'a.mp3')
    const second = music.lastIndexOf('-i')
    expect(music.slice(second - 2, second + 2)).toEqual(['-ss', '5.000', '-i', 'a.mp3'])
    expect(music).toContain('1:a:0?')
    expect(music).not.toContain('0:a:0?')
    expect(music.slice(music.indexOf('-af'), music.indexOf('-af') + 3)).toEqual(['-af', 'apad', '-shortest'])
    const silent = streamArgs('a.mp4', 5_000, plan, null)
    expect(silent.some((a) => a.includes(':a:'))).toBe(false)
  })

  it('writes the tracking frames to pipe 3 at up to 30 fps, at the size the engine decodes to', () => {
    const plan = { width: 7680, height: 3840, fps: 60, scale: false }
    expect(trackFrames(plan)).toEqual({ width: 384, height: 192, bytes: 384 * 192 * 4, step: 2, fps: 30 })
    expect(trackFrames({ ...plan, width: 1920, height: 1080, fps: 30 })).toMatchObject({ height: 216, step: 1, fps: 30 })
    expect(trackFrames({ ...plan, fps: 50 })).toMatchObject({ step: 2, fps: 25 })
    const args = streamArgs('a.mp4', 0, plan)
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(';[t]framestep=2,scale_cuda=1536:-2:format=nv12,hwdownload,format=nv12,scale=384:192:flags=bicubic,format=bgra[k]')
    expect(args.slice(-5)).toEqual(['-map', '[k]', '-f', 'rawvideo', 'pipe:3'])
  })
})

describe('frameSplitter', () => {
  it('joins frames split across reads, timed from the start at the rate, copying only wanted ones', () => {
    const got: [number[], number][] = []
    let want = true
    const push = frameSplitter(4, 5_000, 50, () => want, (frame, timeMs) => got.push([[...frame], timeMs]))
    push(Buffer.from([1, 2, 3]))
    push(Buffer.from([4, 5, 6, 7, 8]))
    want = false
    push(Buffer.from([9, 10, 11, 12]))
    want = true
    push(Buffer.from([13, 14, 15, 16, 17]))
    expect(got).toEqual([
      [[1, 2, 3, 4], 5_000],
      [[5, 6, 7, 8], 5_020],
      [[13, 14, 15, 16], 5_060],
    ])
  })
})

const nvenc = (() => {
  if (!process.env.BP_NVENC_TEST) return false
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('hevc_nvenc')
  } catch {
    return false
  }
})()

describe.runIf(nvenc)('the encode on this PC', () => {
  it('streams MPEG-TS on stdout and every frame, whole, on pipe 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-quest-stream-'))
    try {
      const file = join(dir, 'in.mp4')
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file])
      const plan = { width: 1280, height: 720, fps: 60, scale: false }
      const { width, height, bytes, fps } = trackFrames(plan)
      const times: number[] = []
      const encode = await new QuestStreams().open('h', { path: file, mtime: 0 }, streamArgs(file, 0, plan), frameSplitter(bytes, 0, fps, () => true, (frame, timeMs) => {
        expect(frame.length).toBe(width * height * 4)
        times.push(timeMs)
      }))
      if (!encode) throw new Error('no encode')
      const ts: Buffer[] = []
      encode.stdout.on('data', (d: Buffer) => ts.push(d))
      expect(await encode.exited).toBe(0)
      expect(Buffer.concat(ts)[0]).toBe(0x47)
      expect(times).toHaveLength(60)
      expect(times[30]).toBeCloseTo(1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('QuestStreams.plan', () => {
  const file = { path: 'D:/v/a.mp4', mtime: 1, size: 1e9, durationMs: 600_000 }
  const json = '{"streams":[{"codec_name":"av1","width":7680,"height":3840,"avg_frame_rate":"120/1"}]}'

  it('probes a file once per mtime, and offers nothing without an encoder or after a failed probe', async () => {
    const probe = vi.fn(async () => json)
    const streams = new QuestStreams({ probe, encoder: async () => true })
    expect(await streams.plan(file)).toEqual({ width: 7680, height: 3840, fps: 60, scale: false })
    await streams.plan(file)
    expect(probe).toHaveBeenCalledTimes(1)
    await streams.plan({ ...file, mtime: 2 })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(await new QuestStreams({ probe, encoder: async () => false }).plan(file)).toBeNull()
    expect(await new QuestStreams({ probe: async () => Promise.reject(new Error('no ffprobe')), encoder: async () => true }).plan(file)).toBeNull()
  })

  it('checks the encoder only for a file that needs it, keeping a pass and trying a failure again', async () => {
    const small = async () => '{"streams":[{"codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1"}]}'
    const unused = vi.fn(async () => true)
    expect(await new QuestStreams({ probe: small, encoder: unused }).plan(file)).toBeNull()
    expect(unused).not.toHaveBeenCalled()
    const encoder = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true)
    const streams = new QuestStreams({ probe: async () => json, encoder })
    expect(await streams.plan(file)).toBeNull()
    expect(await streams.plan(file)).not.toBeNull()
    await streams.plan(file)
    expect(encoder).toHaveBeenCalledTimes(2)
  })

  it('plays a file directly once its encode fails before any output, but not after a kill or a later failure', async () => {
    const exits: ((code: number | null) => void)[] = []
    const output: boolean[] = []
    const spawn = async (): Promise<Encode> => {
      const exited = new Promise<number | null>((done) => exits.push(done))
      const i = output.push(false) - 1
      return { stdout: new PassThrough(), exited, produced: () => output[i] ?? false, kill: () => {}, stderr: () => '' }
    }
    const streams = new QuestStreams({ probe: async () => json, encoder: async () => true, spawn })
    const exit = async (code: number | null, produced = false) => {
      await streams.open('h', file, [])
      output[output.length - 1] = produced
      exits.at(-1)?.(code)
      await Promise.resolve()
    }
    await exit(null)
    await exit(1, true)
    expect(await streams.plan(file)).not.toBeNull()
    await exit(1)
    expect(await streams.plan(file)).toBeNull()
    expect(await streams.plan({ ...file, mtime: 2 })).not.toBeNull()
  })
})

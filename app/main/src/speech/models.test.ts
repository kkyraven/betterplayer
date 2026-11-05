import { describe, expect, it } from 'vitest'
import { VOICE_MODELS, VOICE_SIZE_MB } from '@shared/speech'
import type { ModelFileInfo, ModelFileStatus } from '@shared/tracking'
import { VoiceModels } from './models'

const ALL = VOICE_MODELS.flatMap((m) => m.files.map((f) => f.file))

function fakeModels(present: string[] = []) {
  const disk = new Set(present)
  const started: string[] = []
  const pending: { file: string; done: () => void; fail: (e: Error) => void }[] = []
  return {
    disk, started,
    finish: () => { const p = pending.shift()!; disk.add(p.file); p.done() },
    fail: (why: string) => pending.shift()!.fail(new Error(why)),
    status: (files: string[]) => Object.fromEntries(files.map((f): [string, ModelFileStatus | null] => [f, disk.has(f) ? { path: `/models/${f}`, bytes: 1000 } : null])),
    download: (_id: string, file: ModelFileInfo) => new Promise<void>((done, fail) => {
      started.push(file.file)
      pending.push({ file: file.file, done, fail })
    }),
  }
}

const flush = () => new Promise((done) => setTimeout(done, 0))

describe('VoiceModels', () => {
  it('is missing, then downloads every file in turn with bytes across them all, then is ready', async () => {
    const models = fakeModels()
    const voice = new VoiceModels(models)
    expect(voice.state()).toEqual({ kind: 'missing', sizeMb: VOICE_SIZE_MB })
    expect(voice.files()).toBeNull()
    void voice.download()
    void voice.download()
    voice.progress({ id: VOICE_MODELS[0].id, done: 500, total: 2000 })
    expect(voice.state()).toEqual({ kind: 'downloading', done: 500, total: VOICE_SIZE_MB * 1024 * 1024 })
    models.finish()
    await flush()
    expect(voice.state()).toMatchObject({ kind: 'downloading', done: 1000 })
    for (let i = 1; i < ALL.length; i++) { models.finish(); await flush() }
    expect(models.started).toEqual(ALL)
    expect(voice.state()).toEqual({ kind: 'ready' })
    expect(voice.files()).toEqual({
      encoder: '/models/whisper-base-en-encoder.onnx', decoder: '/models/whisper-base-en-decoder.onnx',
      tokenizer: '/models/whisper-base-en-tokenizer.json', vad: '/models/silero-vad.onnx',
    })
  })

  it('shows a failure until the next try, which fetches only what is missing', async () => {
    const models = fakeModels([ALL[0]!])
    const voice = new VoiceModels(models)
    const first = voice.download()
    models.fail('offline')
    await first
    expect(voice.state()).toEqual({ kind: 'failed', error: 'offline' })
    void voice.download()
    expect(voice.state().kind).toBe('downloading')
    expect(models.started).toEqual([ALL[1], ALL[1]])
  })

  it("joins Settings' fetch of a file rather than fetching it twice", async () => {
    const models = fakeModels()
    const voice = new VoiceModels(models)
    const file = VOICE_MODELS[0].files[0]!
    const settings = voice.fetch(VOICE_MODELS[0].id, file)
    void voice.download()
    expect(models.started).toEqual([file.file])
    models.finish()
    await settings
    await flush()
    expect(models.started).toEqual([file.file, ALL[1]])
  })
})

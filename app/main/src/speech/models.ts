import { VOICE_MODELS, VOICE_SIZE_MB, type SpeechModelState } from '@shared/speech'
import type { ModelFileInfo, ModelProgress } from '@shared/tracking'
import type { Models } from '../models'
import type { SpeechFiles } from './engine'

const VOICE_FILES = VOICE_MODELS.flatMap((m) => m.files.map((f) => f.file))
const [ENCODER, DECODER, TOKENIZER] = VOICE_MODELS[0].files.map((f) => f.file)
const VAD = VOICE_MODELS[1].files[0]!.file

export const isVoiceModel = (id: string) => VOICE_MODELS.some((m) => m.id === id)

export class VoiceModels {
  private readonly fetching = new Map<string, Promise<void>>()
  private readonly partial = new Map<string, { file: string; done: number }>()
  private all: Promise<void> | null = null
  private error: string | null = null

  constructor(private readonly models: Pick<Models, 'status' | 'download'>) {}

  files(): SpeechFiles | null {
    const s = this.models.status(VOICE_FILES)
    const path = (file: string | undefined) => (file ? s[file]?.path : undefined)
    const [encoder, decoder, tokenizer, vad] = [path(ENCODER), path(DECODER), path(TOKENIZER), path(VAD)]
    return encoder && decoder && tokenizer && vad ? { encoder, decoder, tokenizer, vad } : null
  }

  state(): SpeechModelState {
    const s = this.models.status(VOICE_FILES)
    const present = VOICE_FILES.filter((f) => s[f])
    if (present.length === VOICE_FILES.length) return { kind: 'ready' }
    if (this.fetching.size > 0) {
      const done = present.reduce((sum, f) => sum + (s[f]?.bytes ?? 0), 0) + [...this.partial.values()].reduce((sum, p) => sum + p.done, 0)
      return { kind: 'downloading', done, total: Math.max(done, VOICE_SIZE_MB * 1024 * 1024) }
    }
    if (this.error !== null) return { kind: 'failed', error: this.error }
    return { kind: 'missing', sizeMb: VOICE_SIZE_MB }
  }

  progress(p: ModelProgress) {
    const at = this.partial.get(p.id)
    if (at) at.done = p.done
  }

  fetch(id: string, file: ModelFileInfo): Promise<void> {
    const running = this.fetching.get(file.file)
    if (running) return running
    this.partial.set(id, { file: file.file, done: 0 })
    const run = this.models.download(id, file).finally(() => {
      this.fetching.delete(file.file)
      if (this.partial.get(id)?.file === file.file) this.partial.delete(id)
    })
    this.fetching.set(file.file, run)
    return run
  }

  download(): Promise<void> {
    if (this.all) return this.all
    this.error = null
    this.all = (async () => {
      for (const model of VOICE_MODELS) {
        const s = this.models.status(model.files.map((f) => f.file))
        for (const file of model.files) if (!s[file.file]) await this.fetch(model.id, file)
      }
    })()
      .catch((e: unknown) => { this.error = e instanceof Error ? e.message : String(e) })
      .finally(() => { this.all = null })
    return this.all
  }
}

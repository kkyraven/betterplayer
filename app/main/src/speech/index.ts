import type { Chip } from '@shared/portals'
import type { SpeechFinal, SpeechKind, SpeechModelState, SpeechReply, SpeechWord } from '@shared/speech'
import type { Library } from '../library'
import type { Models } from '../models'
import { Endpointer } from './endpoint'
import { WorkerEar, WorkerVoice, type SpeechEar, type SpeechVoice } from './engine'
import { VoiceModels } from './models'
import { voiceChips, voiceWords, withAlts } from './parse'
import { libraryCorrections, librarySource, VocabularyCache, type Vocabulary } from './vocabulary'

const DROP_MS = 15_000
const PARTIAL_MS = 500
const MAX_SAMPLES = 30 * 16_000

export interface SpeechDeps {
  ear: SpeechEar
  voice: SpeechVoice
  vocabulary: () => Vocabulary
  corrections: (chips: readonly Chip[]) => Promise<{ from: string; to: string }[]>
  replyPrompt: () => Promise<string>
  now?: () => number
}

interface Session {
  id: string
  seq: number
  readonly early: Map<number, Int16Array>
  pcm: Int16Array
  samples: number
  readonly endpoint: Endpointer
  heard: Promise<void>
  words: SpeechWord[]
  decoding: boolean
  decodedAt: number
  decodedSamples: number
  final: Promise<SpeechFinal> | null
  drop: NodeJS.Timeout | null
  kind: SpeechKind
  vocabulary: Vocabulary
  prompt: Promise<string>
}

const NOTHING: SpeechFinal = { words: [], chips: [] }

const saidWords = (text: string): SpeechWord[] => text.trim().split(/\s+/).filter(Boolean).map((word) => ({ text: word, filter: false }))

export class Speech {
  private session: Session | null = null
  private readonly now: () => number

  constructor(private readonly deps: SpeechDeps) {
    this.now = deps.now ?? Date.now
  }

  async chunk(id: string, seq: number, pcm: Int16Array, kind: SpeechKind = 'search'): Promise<SpeechReply> {
    let s = this.session?.id === id ? this.session : null
    if (!s) {
      if (seq !== 0) return { words: [], end: 'silent' }
      s = this.open(id, kind)
    }
    this.keep(s)
    if (s.endpoint.end !== 'none' || seq < s.seq || s.early.has(seq)) return this.reply(s)
    s.early.set(seq, pcm)
    const fresh: Int16Array[] = []
    for (let next = s.early.get(s.seq); next; next = s.early.get(s.seq)) {
      s.early.delete(s.seq++)
      fresh.push(next)
      this.append(s, next)
    }
    const session = s
    for (const piece of fresh) {
      session.heard = session.heard.then(async () => {
        if (this.session !== session || session.endpoint.end !== 'none') return
        if (session.endpoint.push(await this.deps.ear.vad(piece)) === 'speech') session.final ??= this.decodeFinal(session)
      })
    }
    try {
      await session.heard
    } catch (e) {
      this.close(session)
      throw e
    }
    this.livePartial(session)
    return this.reply(session)
  }

  async end(id: string): Promise<SpeechFinal> {
    const s = this.session?.id === id ? this.session : null
    if (!s) return NOTHING
    try {
      await s.heard.catch(() => undefined)
      return await (s.final ??= this.decodeFinal(s))
    } finally {
      this.close(s)
    }
  }

  cancel(id: string) {
    if (this.session?.id === id) this.close(this.session)
  }

  private open(id: string, kind: SpeechKind): Session {
    if (this.session) this.close(this.session)
    const vocabulary = this.deps.vocabulary()
    const s: Session = {
      id, seq: 0, early: new Map(), pcm: new Int16Array(16_000 * 4), samples: 0, endpoint: new Endpointer(),
      heard: this.deps.ear.reset(), words: [], decoding: false, decodedAt: 0, decodedSamples: 0, final: null,
      drop: null, kind, vocabulary,
      prompt: kind === 'reply' ? this.deps.replyPrompt().catch(() => '') : Promise.resolve(vocabulary.prompt),
    }
    this.session = s
    return s
  }

  private close(s: Session) {
    if (s.drop) clearTimeout(s.drop)
    if (this.session === s) this.session = null
    s.pcm = new Int16Array(0)
    s.early.clear()
  }

  private keep(s: Session) {
    if (s.drop) clearTimeout(s.drop)
    s.drop = setTimeout(() => this.close(s), DROP_MS)
    s.drop.unref()
  }

  private append(s: Session, pcm: Int16Array) {
    const room = MAX_SAMPLES - s.samples
    const take = pcm.length > room ? pcm.subarray(0, room) : pcm
    if (s.samples + take.length > s.pcm.length) {
      const grown = new Int16Array(Math.min(MAX_SAMPLES, Math.max(s.pcm.length * 2, s.samples + take.length)))
      grown.set(s.pcm.subarray(0, s.samples))
      s.pcm = grown
    }
    s.pcm.set(take, s.samples)
    s.samples += take.length
  }

  private reply(s: Session): SpeechReply {
    return { words: s.words, end: s.endpoint.end }
  }

  private utterance(s: Session): Int16Array | null {
    const start = s.endpoint.startSample
    return start === null ? null : s.pcm.slice(start, Math.min(s.samples, s.endpoint.samples))
  }

  private livePartial(s: Session) {
    if (s.decoding || s.final || s.endpoint.end !== 'none' || this.now() - s.decodedAt < PARTIAL_MS) return
    const pcm = this.utterance(s)
    if (!pcm || s.endpoint.samples <= s.decodedSamples) return
    s.decoding = true
    s.decodedAt = this.now()
    s.decodedSamples = s.endpoint.samples
    void s.prompt.then((prompt) => this.deps.voice.transcribe(pcm, prompt))
      .then((text) => {
        if (this.session === s && !s.final) s.words = s.kind === 'reply' ? saidWords(text) : voiceChips(voiceWords(text), s.vocabulary.tags).words
      })
      .catch(() => undefined)
      .finally(() => { s.decoding = false })
  }

  private async decodeFinal(s: Session): Promise<SpeechFinal> {
    const pcm = this.utterance(s)
    if (!pcm) return NOTHING
    const text = await this.deps.voice.transcribe(pcm, await s.prompt)
    if (s.kind === 'reply') return { words: saidWords(text), chips: [], text: text.trim() }
    const { chips, words } = voiceChips(voiceWords(text), s.vocabulary.tags)
    if (!chips.some((c) => c.kind === 'text')) return { words, chips }
    const corrections = await this.deps.corrections(chips).catch(() => [])
    return { words, chips: withAlts(chips, corrections, s.vocabulary.tags) }
  }
}

export interface SpeechApi {
  model(): SpeechModelState
  download(): void
  chunk(session: string, seq: number, pcm: Int16Array, kind?: SpeechKind): Promise<SpeechReply>
  end(session: string): Promise<SpeechFinal>
  cancel(session: string): void
}

export function voiceSearch(enginePath: string, models: Pick<Models, 'status' | 'download'>, library: Pick<Library, 'tags' | 'index' | 'performerNames' | 'prepareSearch' | 'query'>, replyPrompt: () => Promise<string>) {
  const files = new VoiceModels(models)
  const ear = new WorkerEar(enginePath, () => files.files())
  const voice = new WorkerVoice(enginePath, () => files.files())
  const vocabulary = new VocabularyCache(librarySource(library))
  const speech = new Speech({ ear, voice, vocabulary: () => vocabulary.get(), corrections: (chips) => libraryCorrections(library, chips), replyPrompt })
  const api: SpeechApi = {
    model: () => {
      const state = files.state()
      if (state.kind === 'ready') { ear.warm(); voice.warm() }
      return state
    },
    download: () => void files.download(),
    chunk: (session, seq, pcm, kind) => speech.chunk(session, seq, pcm, kind),
    end: (session) => speech.end(session),
    cancel: (session) => speech.cancel(session),
  }
  return { api, files, vocabulary }
}

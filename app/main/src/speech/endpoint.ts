import { SPEECH_RATE } from '@shared/speech'

export const ENDPOINT = {
  frame: 512,
  speech: 0.5,
  quiet: 0.35,
  startMs: 250,
  startWindowMs: 400,
  endQuietMs: 900,
  noStartMs: 6000,
  maxMs: 20_000,
  preRollMs: 300,
} as const

const FRAME_MS = (ENDPOINT.frame / SPEECH_RATE) * 1000
const frames = (ms: number) => Math.ceil(ms / FRAME_MS)
const START_FRAMES = frames(ENDPOINT.startMs)
const WINDOW_FRAMES = frames(ENDPOINT.startWindowMs)
const END_FRAMES = frames(ENDPOINT.endQuietMs)
const NO_START_FRAMES = frames(ENDPOINT.noStartMs)
const MAX_FRAMES = frames(ENDPOINT.maxMs)

export type EndReason = 'none' | 'speech' | 'silent'

export class Endpointer {
  private n = 0
  private start: number | null = null
  private quietRun = 0
  private readonly window: boolean[] = []
  end: EndReason = 'none'

  push(probs: ArrayLike<number>): EndReason {
    for (let k = 0; k < probs.length && this.end === 'none'; k++) this.frame(probs[k]!)
    return this.end
  }

  private frame(p: number) {
    const i = this.n++
    if (this.start === null) {
      this.window.push(p >= ENDPOINT.speech)
      if (this.window.length > WINDOW_FRAMES) this.window.shift()
      if (this.window.filter(Boolean).length >= START_FRAMES) this.start = i - this.window.length + 1 + this.window.indexOf(true)
      else if (this.n >= NO_START_FRAMES) this.end = 'silent'
      return
    }
    this.quietRun = p < ENDPOINT.quiet ? this.quietRun + 1 : 0
    if (this.quietRun >= END_FRAMES || this.n - this.start >= MAX_FRAMES) this.end = 'speech'
  }

  get started(): boolean {
    return this.start !== null
  }

  get startSample(): number | null {
    return this.start === null ? null : Math.max(0, this.start * ENDPOINT.frame - (ENDPOINT.preRollMs * SPEECH_RATE) / 1000)
  }

  get samples(): number {
    return this.n * ENDPOINT.frame
  }
}

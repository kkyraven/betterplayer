import { VR_DECK_IDLE_MS, VR_DECK_PEEK_MS, type VrDeckMode, type VrPeek, type VrShortcut } from '@shared/vr'

export class DeckIdle {
  private usedAt: number
  private peekUntil = 0
  private cause: VrPeek | null = null
  private screen = false
  private loaded = false

  constructor(now: number) {
    this.usedAt = now
  }

  open(now: number) {
    this.usedAt = now
    this.peekUntil = 0
  }

  peek(now: number, shortcut?: VrShortcut) {
    if (this.mode(now) === 'open') {
      this.usedAt = now
      return
    }
    const again = now < this.peekUntil && shortcut !== undefined && this.cause?.shortcut === shortcut
    this.cause = shortcut ? { shortcut, count: again && this.cause ? this.cause.count + 1 : 1 } : null
    this.peekUntil = now + VR_DECK_PEEK_MS
  }

  use(now: number) {
    if (this.mode(now) === 'open') this.usedAt = now
  }

  setScreen(shown: boolean, now: number) {
    if (shown !== this.screen) this.open(now)
    this.screen = shown
  }

  setLoaded(loaded: boolean, now: number) {
    if (loaded !== this.loaded) this.open(now)
    this.loaded = loaded
  }

  mode(now: number): VrDeckMode {
    if (this.screen || !this.loaded) return 'open'
    if (now - this.usedAt < VR_DECK_IDLE_MS) return 'open'
    return now < this.peekUntil ? 'peek' : 'hidden'
  }

  peeked(now: number): VrPeek | null {
    return this.mode(now) === 'peek' ? this.cause : null
  }
}

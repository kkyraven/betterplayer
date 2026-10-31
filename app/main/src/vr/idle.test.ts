import { describe, expect, it } from 'vitest'
import { VR_DECK_IDLE_MS, VR_DECK_PEEK_MS } from '@shared/vr'
import { DeckIdle } from './idle'

function loaded() {
  const idle = new DeckIdle(0)
  idle.setLoaded(true, 0)
  return idle
}

describe('DeckIdle', () => {
  it('hides the idle time after the laser was last used', () => {
    const idle = loaded()
    idle.use(1000)
    expect(idle.mode(1000 + VR_DECK_IDLE_MS - 1)).toBe('open')
    expect(idle.mode(1000 + VR_DECK_IDLE_MS)).toBe('hidden')
  })

  it('stays open while the big screen is up or nothing is loaded, and waits afresh after either', () => {
    const idle = new DeckIdle(0)
    expect(idle.mode(60_000)).toBe('open')
    idle.setLoaded(true, 60_000)
    idle.setScreen(true, 60_000)
    expect(idle.mode(120_000)).toBe('open')
    idle.setScreen(false, 120_000)
    expect(idle.mode(120_000 + VR_DECK_IDLE_MS - 1)).toBe('open')
    expect(idle.mode(120_000 + VR_DECK_IDLE_MS)).toBe('hidden')
  })

  it('peeks for the peek time, then hides', () => {
    const idle = loaded()
    idle.peek(10_000)
    expect(idle.mode(10_000 + VR_DECK_PEEK_MS - 1)).toBe('peek')
    expect(idle.mode(10_000 + VR_DECK_PEEK_MS)).toBe('hidden')
  })

  it('never lets a peek take the laser away; on an open deck it counts as activity', () => {
    const idle = loaded()
    idle.peek(VR_DECK_IDLE_MS - 1)
    expect(idle.mode(VR_DECK_IDLE_MS * 2 - 2)).toBe('open')
    expect(idle.mode(VR_DECK_IDLE_MS * 2 - 1)).toBe('hidden')
  })

  it('opens from a peek, and laser use only keeps an open deck open', () => {
    const idle = loaded()
    idle.peek(10_000)
    idle.use(10_100)
    expect(idle.mode(10_000 + VR_DECK_PEEK_MS)).toBe('hidden')
    idle.peek(20_000)
    idle.open(20_100)
    expect(idle.mode(20_100 + VR_DECK_IDLE_MS - 1)).toBe('open')
  })

  it('says which shortcut peeked it, counting the same one in a row during the peek', () => {
    const idle = loaded()
    idle.peek(10_000, 'seekForward')
    idle.peek(10_400, 'seekForward')
    expect(idle.peeked(10_400)).toEqual({ shortcut: 'seekForward', count: 2 })
    idle.peek(10_800, 'seekBack')
    expect(idle.peeked(10_800)).toEqual({ shortcut: 'seekBack', count: 1 })
    idle.peek(20_000, 'seekBack')
    expect(idle.peeked(20_000)).toEqual({ shortcut: 'seekBack', count: 1 })
    idle.peek(20_100)
    expect(idle.peeked(20_100)).toBeNull()
    idle.open(30_000)
    expect(idle.peeked(30_000)).toBeNull()
  })
})

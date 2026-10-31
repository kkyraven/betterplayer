import type { PointerEvent as ReactPointerEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaRow } from '@shared/library'

const openTvOptions = vi.hoisted(() => vi.fn())
vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ openTvOptions }) } }))
const { holdForOptions, playOnClick } = await import('./tvCards')

const row = { id: 1 } as MediaRow
const fire = (type: string, props: Record<string, number> = {}) => {
  const e = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries(props)) Object.defineProperty(e, key, { value })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }))
  openTvOptions.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('playOnClick', () => {
  it('plays a known tile once and nothing for an unknown id', () => {
    const play = vi.fn()
    const click = playOnClick([row], play)
    click(2)
    expect(play).not.toHaveBeenCalled()
    click(1)
    expect(play).toHaveBeenCalledExactlyOnceWith(row)
  })

  it('drops the rest of a double click for a second, never a single click', () => {
    playOnClick([row], vi.fn())(1)
    expect(['mousedown', 'click', 'dblclick'].map((type) => fire(type, { detail: 2 }))).toEqual([true, true, true])
    expect(fire('click', { detail: 1 })).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(fire('click', { detail: 2 })).toBe(false)
  })
})

describe('holdForOptions', () => {
  const press = () => holdForOptions({ button: 0, clientX: 100, clientY: 100 } as ReactPointerEvent<HTMLDivElement>, row)

  it('opens the options once the press is held through a laser waver', () => {
    press()
    fire('pointermove', { clientX: 110, clientY: 108 })
    vi.advanceTimersByTime(450)
    expect(openTvOptions).toHaveBeenCalledExactlyOnceWith(row)
  })

  it('does nothing after a release or a move away', () => {
    press()
    fire('pointerup')
    press()
    fire('pointermove', { clientX: 130, clientY: 100 })
    vi.advanceTimersByTime(1000)
    expect(openTvOptions).not.toHaveBeenCalled()
  })
})

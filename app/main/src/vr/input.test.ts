import { describe, expect, it } from 'vitest'
import type { VrOverlayEvent } from 'bp-engine'
import { JITTER_TEXELS, PanelPointer, SCROLL_PX } from './input'

const event = (kind: string, x = 0, y = 0, extra: Partial<VrOverlayEvent> = {}): VrOverlayEvent => ({ overlay: 0, kind, x, y, button: 1, dx: 0, dy: 0, ...extra })

describe('PanelPointer', () => {
  it('rounds and clamps positions to the panel', () => {
    const pointer = new PanelPointer(1280, 440)
    expect(pointer.input(event('move', 100.6, 20.2))).toEqual({ type: 'mouseMove', x: 101, y: 20 })
    expect(pointer.input(event('move', -3, 900))).toEqual({ type: 'mouseMove', x: 0, y: 439 })
    expect(pointer.input(event('move', 1280, 0))).toEqual({ type: 'mouseMove', x: 1279, y: 0 })
  })

  it('clicks with the mapped button and marks moves while it is held', () => {
    const pointer = new PanelPointer(1280, 440)
    expect(pointer.input(event('down', 10, 20))).toEqual({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 })
    expect(pointer.input(event('move', 30, 20))).toEqual({ type: 'mouseMove', x: 30, y: 20, modifiers: ['leftbuttondown'] })
    expect(pointer.input(event('up', 30, 20))).toEqual({ type: 'mouseUp', x: 30, y: 20, button: 'left', clickCount: 1 })
    expect(pointer.input(event('move', 31, 20))).toEqual({ type: 'mouseMove', x: 31, y: 20 })
    expect(pointer.input(event('down', 5, 5, { button: 2 }))).toMatchObject({ button: 'right' })
    expect(pointer.input(event('down', 5, 5, { button: 4 }))).toMatchObject({ button: 'middle' })
  })

  it('maps texels to the window it shows and follows its size', () => {
    const pointer = new PanelPointer(1266, 657, 1899)
    expect(pointer.input(event('move', 949.5, 493.5))).toEqual({ type: 'mouseMove', x: 633, y: 329 })
    expect(pointer.input(event('down', 1899, 986))).toMatchObject({ x: 1265, y: 656 })
    pointer.input(event('up', 1899, 986))
    pointer.fit(2560, 1344, 2560)
    expect(pointer.input(event('move', 1280, 672))).toEqual({ type: 'mouseMove', x: 1280, y: 672 })
    pointer.fit(1280, 720, 2560)
    expect(pointer.input(event('move', 1280, 672))).toEqual({ type: 'mouseMove', x: 640, y: 336 })
    expect(pointer.input(event('scroll', 0, 0, { dy: 1 }))).toMatchObject({ x: 640, y: 336 })
  })

  it('scrolls where the pointer last was, the way the stick points', () => {
    const pointer = new PanelPointer(1920, 1080)
    pointer.input(event('move', 400, 600))
    expect(pointer.input(event('scroll', 0, 0, { dx: 0, dy: -1 }))).toEqual({ type: 'mouseWheel', x: 400, y: 600, deltaX: 0, deltaY: -SCROLL_PX, canScroll: true })
    expect(pointer.input(event('scroll', 0, 0, { dx: 1 }))).toMatchObject({ deltaX: -SCROLL_PX })
  })

  it('ends hover where the laser left', () => {
    const pointer = new PanelPointer(1280, 440)
    pointer.input(event('move', 50, 60))
    expect(pointer.input(event('leave'))).toEqual({ type: 'mouseLeave', x: 50, y: 60 })
  })

  it('ignores events a window does not take', () => {
    const pointer = new PanelPointer(1920, 1080)
    for (const kind of ['press', 'mounted', 'unmounted', 'quit']) expect(pointer.input(event(kind))).toBeNull()
  })
})

describe('PanelPointer.used', () => {
  it('counts clicks, scrolls and moves past jitter, measured from the last move that counted', () => {
    const pointer = new PanelPointer(1280, 440)
    expect(pointer.used(event('move', 100, 100))).toBe(true)
    expect(pointer.used(event('move', 100 + JITTER_TEXELS, 100))).toBe(false)
    expect(pointer.used(event('move', 104, 104))).toBe(false)
    expect(pointer.used(event('move', 105, 105))).toBe(true)
    expect(pointer.used(event('down', 105, 105))).toBe(true)
    expect(pointer.used(event('up', 105, 105))).toBe(true)
    expect(pointer.used(event('scroll', 0, 0, { dy: 1 }))).toBe(true)
    for (const kind of ['press', 'mounted', 'unmounted', 'quit']) expect(pointer.used(event(kind))).toBe(false)
  })

  it('counts the laser coming back where it left', () => {
    const pointer = new PanelPointer(1280, 440)
    pointer.used(event('move', 50, 60))
    expect(pointer.used(event('leave'))).toBe(false)
    expect(pointer.used(event('move', 50, 60))).toBe(true)
  })

  it('lets go of a held button where it is when the laser goes', () => {
    const pointer = new PanelPointer(1280, 440)
    pointer.input(event('down', 40, 50))
    expect(pointer.holding).toBe(true)
    expect(pointer.release()).toEqual([
      { type: 'mouseUp', x: 40, y: 50, button: 'left', clickCount: 1 },
      { type: 'mouseLeave', x: 40, y: 50 },
    ])
    expect(pointer.holding).toBe(false)
    expect(pointer.input(event('move', 60, 50))).toEqual({ type: 'mouseMove', x: 60, y: 50 })
    expect(pointer.release()).toEqual([{ type: 'mouseLeave', x: 60, y: 50 }])
  })
})

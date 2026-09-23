import { describe, expect, it } from 'vitest'
import { defaultView, fitAll, pan, tickStepMs, windowStart, zoomAboutPlayhead, zoomToRange } from './view'

describe('view', () => {
  it('pins the playhead at 35 percent while following', () => {
    const v = { ...defaultView(), zoomMs: 10_000 }
    expect(windowStart(v, 60_000, 300_000)).toBe(56_500)
    expect(windowStart({ ...v, centre: true }, 60_000, 300_000)).toBe(55_000)
  })
  it('lets the window run a little past either end', () => {
    const v = { ...defaultView(), zoomMs: 10_000 }
    expect(windowStart(v, 0, 300_000)).toBe(-1000)
    expect(windowStart(v, 300_000, 300_000)).toBe(291_000)
  })
  it('zooms about the playhead without moving it on screen', () => {
    const v = { ...defaultView(), zoomMs: 10_000, follow: false, startMs: 50_000 }
    const z = zoomAboutPlayhead(v, 0.5, 55_000, 300_000)
    expect(z.zoomMs).toBe(5000)
    expect((55_000 - z.startMs) / z.zoomMs).toBeCloseTo(0.5)
  })
  it('fits a range, fits all and pans', () => {
    const z = zoomToRange(defaultView(), 10_000, 20_000, 300_000)
    expect(z.follow).toBe(false)
    expect(z.zoomMs).toBe(12_000)
    expect(z.startMs).toBe(9000)
    expect(fitAll(defaultView(), 90_000)).toMatchObject({ zoomMs: 90_000, startMs: 0, follow: false })
    expect(pan(defaultView(), 1000, 20_000, 300_000)).toMatchObject({ follow: false, startMs: 20_000 - 8000 * 0.35 + 1000 })
  })
  it('picks round tick steps', () => {
    expect(tickStepMs(8000, 1000)).toBe(1000)
    expect(tickStepMs(600_000, 1000)).toBe(60_000)
  })
})

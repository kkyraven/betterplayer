import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { columnAz, keyframeAt } from './portals'
import {
  INTRO_BOX, INTRO_START, VR_INTRO, introBuzzes, introChrome, introDone, introEnter, introLabel, introLogo, introRank, introShelfDue, introSkip,
  introSkipped, introStep, type IntroClock,
} from './vrIntro'

const FIXTURE = fileURLToPath(new URL('./vrIntro.fixture.json', import.meta.url))

const fixture = () => ({
  constants: VR_INTRO,
  box: INTRO_BOX,
  logo: [0, 200, 600, 1000, 1350, 1500, 1700, 1900, 2100, 2300].map((ms) => ({ ms, ...introLogo(ms) })),
  ranks: ([[0, 0], [1, 0], [2, 1], [3, 1]] as const).map(([column, row]) => ({ az: columnAz(column), row, rank: introRank(columnAz(column), row) })),
  enter: [[0, false], [1.5, false], [1, true]].map(([rank, quick]) => ({ rank, quick, keyframe: introEnter(1000, rank as number, quick as boolean) })),
  labels: [[1100, 0, false], [1300, 0.5, false], [1500, 1.5, false], [1100, 1, true]].map(([now, rank, quick]) => ({ now, rank, quick, value: introLabel(now as number, 1000, rank as number, quick as boolean) })),
  chrome: [[1400, false], [1600, false], [1100, true]].map(([now, quick]) => ({ now, quick, value: introChrome(now as number, 1000, quick as boolean) })),
})

const run = (clock: IntroClock, steps: number, dt: number, ready: boolean) => {
  let c = clock
  for (let i = 0; i < steps; i++) c = introStep(c, dt, ready)
  return c
}

describe('vr intro', () => {
  it('matches vrIntro.fixture.json (UPDATE_INTRO_FIXTURE=1 rewrites it)', () => {
    const now = JSON.parse(JSON.stringify(fixture())) as unknown
    if (process.env.UPDATE_INTRO_FIXTURE === '1') writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n')
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })

  it('draws the whole logo by the hold, and has gone before the middle portals are half in', () => {
    const held = introLogo(VR_INTRO.ms.hold)
    expect([held.draw, held.cap, held.opacity, held.head]).toEqual([1, 1, 1, 0])
    const middle = introEnter(0, 0, false)
    expect(introLogo(VR_INTRO.ms.leave[1]).opacity).toBe(0)
    expect(keyframeAt(middle, VR_INTRO.ms.leave[1] - VR_INTRO.ms.shelf)).toBeLessThan(0.75)
  })

  it('brings the middle columns in first, the bottom row half a step behind', () => {
    expect(introRank(columnAz(1), 0)).toBe(0)
    expect(introRank(columnAz(2), 0)).toBe(0)
    expect(introRank(columnAz(0), 0)).toBeCloseTo(1)
    expect(introRank(columnAz(1), 1)).toBeCloseTo(0.5)
  })

  it('waits at the hold until the library is ready, at most holdMax', () => {
    const waiting = run(INTRO_START, 300, 10, false)
    expect(waiting.ms).toBe(VR_INTRO.ms.hold)
    expect(introShelfDue(waiting)).toBe(false)
    expect(introDone(run(waiting, 200, 10, true))).toBe(true)
    expect(introDone(run(INTRO_START, 1000, 10, false))).toBe(true)
    const stalled = introStep({ ms: 1700, heldMs: 0, skipMs: null }, 600, false)
    expect(stalled).toEqual({ ms: VR_INTRO.ms.hold, heldMs: 550, skipMs: null })
  })

  it('buzzes once, as the corner settles', () => {
    let c = INTRO_START
    let buzzes = 0
    for (let i = 0; i < 400; i++) {
      const next = introStep(c, 10, true)
      if (introBuzzes(c, next)) buzzes++
      c = next
    }
    expect(buzzes).toBe(1)
  })

  it('skips to the end over the skip time, bringing the shelf in at once', () => {
    const skipped = introSkip(run(INTRO_START, 50, 10, true))
    expect(introShelfDue(skipped)).toBe(true)
    expect(introSkipped(skipped)).toBe(0)
    const later = run(skipped, 25, 10, false)
    expect(introSkipped(later)).toBe(1)
    expect(introDone(later)).toBe(true)
    expect(introSkip(later)).toBe(later)
  })
})

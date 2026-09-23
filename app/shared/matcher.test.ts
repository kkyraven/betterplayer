import { describe, expect, it } from 'vitest'
import { LIKELY, MIN_CONFIDENCE, nameSimilarity, parseScriptName, renamedScript, scoreMatch, type MatchFeatures } from './matcher'

const MIN = 60_000

function features(patch: Partial<MatchFeatures>): MatchFeatures {
  return { durationDiffMs: null, videoDurationMs: 20 * MIN, name: 0, timeDiffMs: null, sameFolder: false, ...patch }
}

describe('parseScriptName', () => {
  it('splits a known axis suffix off the stem', () => {
    expect(parseScriptName('scene.sway.funscript')).toEqual({ stem: 'scene', suffix: 'sway', axis: 'L2' })
    expect(parseScriptName('scene.Twist.FUNSCRIPT')).toEqual({ stem: 'scene', suffix: 'Twist', axis: 'R0' })
  })
  it('keeps an unknown suffix as part of the stem and drives the stroke', () => {
    expect(parseScriptName('scene.v2.funscript')).toEqual({ stem: 'scene.v2', suffix: '', axis: 'L0' })
    expect(parseScriptName('scene.funscript')).toEqual({ stem: 'scene', suffix: '', axis: 'L0' })
  })
  it('rejects other files', () => {
    expect(parseScriptName('scene.mp4')).toBeNull()
    expect(parseScriptName('.funscript')).toBeNull()
  })
})

describe('nameSimilarity', () => {
  it('ignores separators, case and encoding tags', () => {
    expect(nameSimilarity('My_Scene-Name [1080p] (h265)', 'my scene name 4K SBS')).toBe(1)
  })
  it('scores a name contained in a longer one well, and unrelated names low', () => {
    expect(nameSimilarity('Studio Scene', 'Studio Scene Part 2')).toBeGreaterThan(0.7)
    expect(nameSimilarity('Studio Scene', 'Another Thing Entirely')).toBeLessThan(0.3)
  })
  it('catches names that only differ in spacing', () => {
    expect(nameSimilarity('StudioSceneName', 'Studio Scene Name')).toBe(1)
  })
})

describe('scoreMatch', () => {
  it('needs duration or name before dates and folder count', () => {
    expect(scoreMatch(features({ timeDiffMs: 0, sameFolder: true })).confidence).toBe(0)
  })
  it('rates same duration plus same name as likely', () => {
    const r = scoreMatch(features({ durationDiffMs: 1000, name: 1 }))
    expect(r.confidence).toBeGreaterThanOrEqual(LIKELY)
    expect(r.reasons).toEqual(['duration', 'name'])
  })
  it('calls a gap over a second similar, not the same', () => {
    expect(scoreMatch(features({ durationDiffMs: 1000 })).reasons).toEqual(['duration'])
    expect(scoreMatch(features({ durationDiffMs: 1001 })).reasons).toEqual(['durationNear'])
    expect(scoreMatch(features({ durationDiffMs: 1001 })).confidence).toBeLessThan(scoreMatch(features({ durationDiffMs: 1000 })).confidence)
  })
  it('still renames on a gap of a few seconds, or half a percent of a long video', () => {
    expect(scoreMatch(features({ durationDiffMs: 3000, name: 1 })).confidence).toBeGreaterThanOrEqual(LIKELY)
    const long = scoreMatch(features({ durationDiffMs: 20_000, videoDurationMs: 120 * MIN, name: 1 }))
    expect(long.reasons).toEqual(['durationNear', 'name'])
    expect(long.confidence).toBeGreaterThanOrEqual(LIKELY)
  })
  it('keeps a near duration ahead of a name alone, so it survives the candidate cut', () => {
    const near = scoreMatch(features({ durationDiffMs: 3000 }))
    expect(near.confidence).toBeGreaterThan(scoreMatch(features({ name: 1 })).confidence)
    expect(near.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)
  })
  it('rates a loose duration alone under the floor, so it is not shown', () => {
    const r = scoreMatch(features({ durationDiffMs: 15_000 }))
    expect(r.reasons).toEqual(['durationNear'])
    expect(r.confidence).toBeLessThan(MIN_CONFIDENCE)
  })
  it('gives the same folder a smaller nudge than a matching date', () => {
    const base = scoreMatch(features({ durationDiffMs: 0 })).confidence
    const folder = scoreMatch(features({ durationDiffMs: 0, sameFolder: true })).confidence - base
    const time = scoreMatch(features({ durationDiffMs: 0, timeDiffMs: 10 * MIN })).confidence - base
    expect(folder).toBeGreaterThan(0)
    expect(folder).toBeLessThan(time)
  })
  it('never exceeds one', () => {
    expect(scoreMatch(features({ durationDiffMs: 0, name: 1, timeDiffMs: 0, sameFolder: true })).confidence).toBe(1)
  })
})

describe('renamedScript', () => {
  it('keeps the axis suffix on the new name', () => {
    expect(renamedScript('video', { name: 'x.sway.funscript', suffix: 'sway', axis: 'L2' })).toBe('video.sway.funscript')
    expect(renamedScript('video', { name: 'x.funscript', suffix: '', axis: 'L0' })).toBe('video.funscript')
  })
})

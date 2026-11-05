import { describe, expect, it, vi } from 'vitest'
import type { MediaDetail } from '@shared/library'
import { FLAT } from '@shared/projection'
import { hereSphereScan, hereSphereScene, readWrite } from './heresphere'

vi.mock('../i18n', () => ({ t: (key: string) => key }))

const row = {
  durationMs: 120_000,
  marks: [
    { name: 'Intro', startMs: 0, endMs: 20_000, source: 'file' as const },
    { name: 'Kiss', startMs: 40_000, endMs: null, source: 'server' as const },
    { name: 'Mine', startMs: 50_000, endMs: null, source: 'headset' as const },
  ],
}

const clip = (tags: string[], marks: MediaDetail['marks']) =>
  ({ id: 1, title: 'clip', addedAt: 0, durationMs: 120_000, rating: 0, favourite: false, height: 1080, width: 1920, size: 1, scripts: [], tags, marks }) as unknown as MediaDetail

describe('readWrite', () => {
  it('keeps timed tags out of the whole-video tags', () => {
    const write = readWrite({ tags: [{ name: 'joi', start: 0, end: 0, track: 0 }, { name: 'Ride', start: 60_000, end: 90_000, track: 0 }, 'pov'] }, row)
    expect(write).toEqual({ tags: ['joi', 'pov'], marks: [{ name: 'Ride', startMs: 60_000, endMs: 90_000 }] })
  })

  it('reads a tag spanning about the whole video as a whole-video tag', () => {
    expect(readWrite({ tags: [{ name: 'vr', start: 0, end: 118_500, track: 2 }] }, row)).toEqual({ tags: ['vr'], marks: [] })
  })

  it('leaves out marks from other sources the headset posted back', () => {
    const write = readWrite({ tags: [{ name: 'Intro', start: 0, end: 20_000, track: 0 }, { name: 'Kiss', start: 40_000, track: 0 }, { name: 'Mine', start: 50_000, track: 0 }] }, row)
    expect(write).toEqual({ tags: [], marks: [{ name: 'Mine', startMs: 50_000, endMs: null }] })
  })

  it('keeps a served chapter starting at 0 a mark when posted back', () => {
    const detail = clip([], [{ name: 'Warmup', startMs: 0, endMs: 15_000, source: 'headset' }])
    const write = readWrite({ tags: hereSphereScene(detail, FLAT, 'http://pc').tags }, detail)
    expect(write).toEqual({ tags: [], marks: [{ name: 'Warmup', startMs: 0, endMs: 15_000 }] })
  })
})

it('serves marks as timed tags that read back as marks', () => {
  const detail = clip(['pov'], row.marks)
  const scene = hereSphereScene(detail, FLAT, 'http://pc')
  expect(scene.tags).toEqual([
    { name: 'pov' },
    { name: 'Intro', start: 0, end: 20_000, track: 0 },
    { name: 'Kiss', start: 40_000, track: 0 },
    { name: 'Mine', start: 50_000, track: 0 },
  ])
  expect(readWrite({ tags: scene.tags }, detail)).toEqual({ tags: ['pov'], marks: [{ name: 'Mine', startMs: 50_000, endMs: null }] })
})

it('scans the library with the links the index gives and durations in milliseconds', () => {
  const rows = [{ id: 3, title: 'clip', durationMs: 120_000, addedAt: Date.UTC(2026, 0, 2), rating: 4, favourite: true, tags: ['pov'] }]
  expect(hereSphereScan(rows, 'http://pc/k/key').scanData).toEqual([
    { link: 'http://pc/k/key/heresphere/3', title: 'clip', dateAdded: '2026-01-02', duration: 120_000, rating: 4, isFavorite: true, tags: [{ name: 'pov' }] },
  ])
})

it('names the external alpha only for a video with one', () => {
  const detail = clip([], [])
  expect(hereSphereScene(detail, FLAT, 'http://pc')).not.toHaveProperty('alphaExternal')
  expect(hereSphereScene(detail, FLAT, 'http://pc', true).alphaExternal).toBe(`http://pc/alpha/${detail.id}`)
})

import { describe, expect, it } from 'vitest'
import { holdBack, mixRecommended, recommendSeed, type MixEntry, type RecommendVideo } from './recommend'

const videos = (n: number, played = 0): RecommendVideo[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    playCount: i < played ? played - i : 0,
    lastPlayed: i < played ? 1000 + i : null,
    addedAt: 5000 - i,
  }))

const videoIds = (mix: ReturnType<typeof mixRecommended>) => mix.filter((e) => e.kind === 'video').map((e) => e.id)
const playlistIds = (mix: ReturnType<typeof mixRecommended>) => mix.filter((e) => e.kind === 'playlist').map((e) => e.id)

describe('mixRecommended', () => {
  it('places every video exactly once', () => {
    const mix = mixRecommended(videos(120, 40), [], 7)
    expect(videoIds(mix).sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
  })

  it('is deterministic for a seed and changes with it', () => {
    const input = videos(80, 20)
    expect(mixRecommended(input, [], 42)).toEqual(mixRecommended(input, [], 42))
    expect(videoIds(mixRecommended(input, [], 43))).not.toEqual(videoIds(mixRecommended(input, [], 42)))
  })

  it('seeds from the day and the id list', () => {
    const ids = [3, 1, 2]
    expect(recommendSeed('2026-09-05', ids)).toBe(recommendSeed('2026-09-05', [2, 3, 1]))
    expect(recommendSeed('2026-09-06', ids)).not.toBe(recommendSeed('2026-09-05', ids))
    expect(recommendSeed('2026-09-05', [1, 2, 4])).not.toBe(recommendSeed('2026-09-05', ids))
  })

  it('places everything when nothing was ever played', () => {
    const mix = mixRecommended(videos(50), [], 7)
    expect(videoIds(mix)).toHaveLength(50)
  })

  it('sprinkles playlists without repeating them', () => {
    const playlists = [
      { id: 1, count: 12 },
      { id: 2, count: 8 },
    ]
    const mix = mixRecommended(videos(120, 40), playlists, 7)
    const shown = playlistIds(mix)
    expect(shown.length).toBeGreaterThan(0)
    expect(new Set(shown).size).toBe(shown.length)
  })

  it('returns nothing for an empty view, even with playlists', () => {
    expect(mixRecommended([], [{ id: 1, count: 3 }], 7)).toEqual([])
  })

  it('favours what is played often', () => {
    const mix = videoIds(mixRecommended(videos(60, 30), [], 7))
    const mean = (pred: (id: number) => boolean) => {
      const positions = mix.map((id, i) => (pred(id) ? i : -1)).filter((i) => i >= 0)
      return positions.reduce((a, b) => a + b, 0) / positions.length
    }
    expect(mean((id) => id <= 30)).toBeLessThan(mean((id) => id > 30))
  })
})

describe('holdBack', () => {
  const video = (id: number): MixEntry => ({ kind: 'video', id })
  const entries = [video(1), video(2), { kind: 'playlist', id: 2 } as MixEntry, video(3), video(4), video(5), video(6)]

  it('moves held videos to just past the head, keeping order', () => {
    expect(holdBack(entries, new Set([2, 4]), 3)).toEqual([video(1), { kind: 'playlist', id: 2 }, video(3), video(2), video(4), video(5), video(6)])
  })

  it('leaves the list alone when nothing held sits in the head', () => {
    expect(holdBack(entries, new Set([6]), 3)).toBe(entries)
    expect(holdBack(entries, new Set(), 3)).toBe(entries)
  })

  it('ignores playlist entries sharing a held id', () => {
    expect(holdBack(entries, new Set([2]), 3)).toEqual([video(1), { kind: 'playlist', id: 2 }, video(3), video(2), video(4), video(5), video(6)])
  })

  it('pushes held videos to the end of a short list', () => {
    expect(holdBack([video(1), video(2)], new Set([1]), 16)).toEqual([video(2), video(1)])
  })
})

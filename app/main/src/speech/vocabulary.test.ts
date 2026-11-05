import { describe, expect, it } from 'vitest'
import { buildVocabulary, VocabularyCache, type VocabularySource } from './vocabulary'

const source = (tags: [string, number][], titles: string[] = [], performers: string[] = []): VocabularySource => ({
  tags: () => tags.map(([name, count]) => ({ name, count })),
  titles: () => titles,
  performers: () => performers,
})

describe('buildVocabulary', () => {
  it('ends with the grammar, the most used tag nearest it, and drops the least important past the limit', () => {
    const titles = ['Sunset Lighthouse', 'Lighthouse at night', 'The Lighthouse', 'Once only']
    const { prompt, tags } = buildVocabulary(source([['Beach', 9], ['Unused', 0], ['Forest', 3]], titles, ['Myra Bale']))
    expect(prompt).toBe('lighthouse, Myra Bale, Forest, Beach, VR, 2D, favourites, fastest, under 20 minutes, over 10 minutes, Beach tag')
    expect(tags).toEqual(['Beach', 'Unused', 'Forest'])
    const many = buildVocabulary(source(Array.from({ length: 40 }, (_, i) => [`tag number ${i}`, 100 - i]), [], Array.from({ length: 30 }, (_, i) => `Performer ${i}`)))
    expect(many.prompt.length).toBeLessThanOrEqual(800)
    expect(many.prompt).toContain('tag number 0, VR')
    expect(many.prompt).not.toContain('Performer 29')
  })
})

describe('VocabularyCache', () => {
  it('rebuilds after a library change, at most every 3 minutes', () => {
    let now = 0
    let builds = 0
    const cache = new VocabularyCache({ ...source([]), tags: () => { builds++; return [] } }, () => now)
    cache.get()
    cache.get()
    cache.changed()
    now = 60_000
    cache.get()
    expect(builds).toBe(1)
    now = 180_000
    cache.get()
    cache.get()
    expect(builds).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { emptyEroSearch, eroSearchError, eroSearchQuery, eroSearchUrl, parseEroSearch, searchQueryFromUrl } from './eroSearch'

describe('EroScripts search', () => {
  it('retains quoted terms and unknown syntax when native searches populate controls', () => {
    const query = '"a test video" category:help tags:vr+multi-axis @creator after:2026-01-01 in:title in:first order:likes status:open min_posts:12'
    const parsed = parseEroSearch(query)
    expect(parsed).toMatchObject({ text: '"a test video" status:open min_posts:12', category: 'help', tags: 'vr, multi-axis', author: 'creator', titleOnly: true, firstPost: true, sort: 'likes' })
    expect(eroSearchQuery(parsed)).toContain('status:open min_posts:12')
    expect(eroSearchQuery(parsed)).toContain('tags:vr+multi-axis')
    expect(parseEroSearch(eroSearchQuery(parsed))).toEqual(parsed)
  })

  it('preserves filters the form cannot safely represent', () => {
    const parsed = parseEroSearch('category:one category:two order:views tags:a+b,c before:2026-02-30')
    expect(parsed.text).toBe('category:one category:two order:views tags:a+b,c before:2026-02-30')
    expect(parsed.category).toBe('')
    expect(parsed.sort).toBe('')
    expect(parsed.before).toBe('')
    expect(parseEroSearch('"unfinished category:help').text).toBe('"unfinished category:help')
    expect(parseEroSearch('order: test').text).toBe('order: test')
  })

  it('builds Any tags and exclusions independently without mutating the raw query', () => {
    const search = { ...emptyEroSearch(), text: 'test status:open', tags: 'vr, non-vr', tagMode: 'any' as const, excludeTags: 'short, preview' }
    expect(eroSearchQuery(search)).toBe('test status:open tags:vr,non-vr -tags:short,preview')
    expect(searchQueryFromUrl(eroSearchUrl(search))).toBe(eroSearchQuery(search))
    expect(searchQueryFromUrl('https://discuss.eroscripts.com/t/test/1234')).toBeNull()
  })

  it('rejects malformed dates, reversed date ranges and filter injection', () => {
    expect(eroSearchError({ ...emptyEroSearch(), after: '2026-02-30' })).toBe('dates')
    expect(eroSearchError({ ...emptyEroSearch(), after: '2026-04-01', before: '2026-03-01' })).toBe('dates')
    expect(eroSearchError({ ...emptyEroSearch(), category: 'help order:latest' })).toBe('category')
    expect(eroSearchError({ ...emptyEroSearch(), tags: 'vr @someone' })).toBe('tags')
    expect(eroSearchError({ ...emptyEroSearch(), author: 'someone in:title' })).toBe('author')
    expect(eroSearchError({ ...emptyEroSearch(), after: '2024-02-29', before: '2026-10-11' })).toBeNull()
  })
})

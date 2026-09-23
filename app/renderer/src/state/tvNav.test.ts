import { describe, expect, it } from 'vitest'
import { tvBack, tvTabStep, type TvNav } from './tvNav'

const nav = (patch: Partial<TvNav> = {}): TvNav => ({ tvTab: 'library', tvViews: [], tvOverlay: 'none', ...patch })

describe('tvBack', () => {
  it('closes the overlay before anything else', () => {
    expect(tvBack(nav({ tvOverlay: 'power', tvViews: [{ kind: 'settings' }] }), true)).toEqual({ tvOverlay: 'none' })
  })
  it('pops the top view', () => {
    const views: TvNav['tvViews'] = [{ kind: 'browse', what: 'tags' }, { kind: 'grid', source: { title: 'vr', tag: 'vr' } }]
    expect(tvBack(nav({ tvViews: views }), false)).toEqual({ tvViews: [views[0]] })
  })
  it('leaves Now playing before popping the views under it', () => {
    expect(tvBack(nav({ tvTab: 'nowplaying', tvViews: [{ kind: 'settings' }] }), true)).toEqual({ tvTab: 'library' })
  })
  it('walks the tab ladder', () => {
    expect(tvBack(nav({ tvTab: 'nowplaying' }), true)).toEqual({ tvTab: 'library' })
    expect(tvBack(nav({ tvTab: 'session' }), true)).toEqual({ tvTab: 'nowplaying' })
    expect(tvBack(nav({ tvTab: 'session' }), false)).toEqual({ tvTab: 'library' })
  })
  it('stops at Library with nothing open', () => {
    expect(tvBack(nav(), false)).toBeNull()
  })
})

describe('tvTabStep', () => {
  it('skips Now playing while nothing is open and wraps', () => {
    expect(tvTabStep('library', -1, false)).toBe('session')
    expect(tvTabStep('library', -1, true)).toBe('nowplaying')
    expect(tvTabStep('session', 1, false)).toBe('library')
  })
})

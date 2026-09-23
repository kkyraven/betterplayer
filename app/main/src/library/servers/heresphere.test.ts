import { afterEach, describe, expect, it, vi } from 'vitest'
import { HereSphereAdapter, mergedTags, ownTags, performersOf, sceneProjection, sceneRating, studioOf } from './heresphere'

const xbvr = [
  { name: 'Studio:Some Studio' },
  { name: 'Talent:Jane Doe' },
  { name: 'Category:anal' },
  { name: 'Category:pov' },
  { name: 'Feature:watchlist' },
  { name: 'Jane Doe', start: 12000, end: 30000, track: 0 },
]

describe('ownTags', () => {
  it('keeps category tags without their prefix and drops the rest', () => {
    expect(ownTags(xbvr)).toEqual(['anal', 'pov'])
  })

  it('keeps unprefixed tags and Tag: ones, never cuepoints', () => {
    expect(ownTags([{ name: 'vr' }, { name: 'Tag:joi' }, { name: 'kiss', start: 5000 }])).toEqual(['vr', 'joi'])
  })
})

describe('studioOf', () => {
  it('reads the studio tag', () => {
    expect(studioOf(xbvr)).toBe('Some Studio')
    expect(studioOf([{ name: 'vr' }])).toBe('')
  })
})

it('imports XBVR and stash-vr performers without treating markers as people', () => {
  expect(performersOf([
    { name: 'Talent:Mira Vale' }, { name: '@:Alex Rowan', track: 5 }, { name: 'Performer: MIRA VALE' },
    { name: 'Mira Vale', start: 1000 }, { name: '#:coast' }, { name: 'Talent: ' },
  ])).toEqual([
    { key: 'name:mira vale', name: 'MIRA VALE', aliases: [] },
    { key: 'name:alex rowan', name: 'Alex Rowan', aliases: [] },
  ])
})

describe('mergedTags', () => {
  it('replaces the category tags and keeps everything else as it came', () => {
    expect(mergedTags(xbvr, ['pov', 'new'])).toEqual([
      { name: 'Studio:Some Studio' },
      { name: 'Talent:Jane Doe' },
      { name: 'Feature:watchlist' },
      { name: 'Jane Doe', start: 12000, end: 30000, track: 0 },
      { name: 'Category:pov' },
      { name: 'Category:new' },
    ])
  })

  it('uses no prefix when the scene had none at all', () => {
    expect(mergedTags([{ name: 'vr' }], ['joi'])).toEqual([{ name: 'joi' }])
  })

  it('prefixes with Category: for a server that uses prefixes but had no plain tags yet', () => {
    expect(mergedTags([{ name: 'Studio:Acme' }], ['joi'])).toEqual([{ name: 'Studio:Acme' }, { name: 'Category:joi' }])
  })
})

describe('sceneRating', () => {
  it('rounds to five stars and ignores the favourite flag', () => {
    expect(sceneRating({ rating: 3.4 })).toBe(3)
    expect(sceneRating({ rating: 2, isFavorite: true })).toBe(2)
    expect(sceneRating({ rating: 5, isFavorite: true })).toBe(5)
    expect(sceneRating({})).toBe(0)
  })
})

describe('sceneProjection', () => {
  it('maps the HereSphere names', () => {
    expect(sceneProjection({ projection: 'equirectangular', stereo: 'sbs' })).toEqual({ kind: 'equirect180', layout: 'sbs', fov: 190, swapEyes: false })
    expect(sceneProjection({ projection: 'fisheye', stereo: 'tb', fov: 200, isEyeSwapped: true })).toEqual({ kind: 'fisheye', layout: 'ou', fov: 200, swapEyes: true })
    expect(sceneProjection({ projection: 'perspective', stereo: 'mono' })).toEqual({ kind: 'flat', layout: 'mono', fov: 190, swapEyes: false })
  })

  it('is null for anything unknown', () => {
    expect(sceneProjection({ projection: 'cubemap', stereo: 'sbs' })).toBeNull()
    expect(sceneProjection({})).toBeNull()
  })
})


const stashTags = [
  { name: '#:vr', track: 3 },
  { name: '#:joi', track: 4 },
  { name: '#:#parent', start: -1, end: -1, track: 2 },
  { name: '#parent:vr', start: -1, end: -1, track: 2 },
  { name: '@:Performer', track: 5 },
  { name: 'Studio:Acme', track: 6 },
  { name: 'kiss:Marker', start: 1000, end: 2000, track: 0 },
]

it('round trips stash-vr scene tags without changing markers or generated metadata', () => {
  expect(ownTags(stashTags)).toEqual(['vr', 'joi'])
  expect(mergedTags(stashTags, ['new'])).toEqual([...stashTags.slice(2), { name: '#:new' }])
  expect(mergedTags(stashTags.slice(2), ['new'])).toEqual([...stashTags.slice(2), { name: '#:new' }])
})

describe('writeBack', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  function respondingServer(doc: Record<string, unknown>) {
    return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const update: unknown = JSON.parse(String(init.body))
      if (typeof update === 'object' && update !== null) Object.assign(doc, update)
      return Promise.resolve(Response.json(doc))
    })
  }
  const adapter = () => new HereSphereAdapter({ url: 'http://server', username: 'user', secret: 'password' })

  it('preserves markers and the remote rating when only tags changed', async () => {
    const fetch = respondingServer({ rating: 2, isFavorite: true, tags: stashTags, writeRating: false })
    vi.stubGlobal('fetch', fetch)
    await adapter().writeBack('http://server/heresphere/1', { rating: 2, favourite: true, tags: ['new'] })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ username: 'user', password: 'password', tags: [...stashTags.slice(2), { name: '#:new' }] })
  })

  it('rejects disabled tag updates before writing anything', async () => {
    const fetch = respondingServer({ rating: 2, tags: [], writeTags: false })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().writeBack('http://server/heresphere/1', { rating: 3, favourite: false, tags: ['new'] })).rejects.toThrow('does not allow tag updates')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('writes a rating on its own, leaving an unchanged favourite and tags out', async () => {
    const fetch = respondingServer({ rating: 2, tags: [], writeFavorite: false })
    vi.stubGlobal('fetch', fetch)
    await adapter().writeBack('http://server/heresphere/1', { rating: 5, favourite: false, tags: [] })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ username: 'user', password: 'password', rating: 5 })
  })

  it('compares tags using the library lowercase normalization', async () => {
    const fetch = respondingServer({ rating: 2, tags: [{ name: 'Category:Anal' }], writeTags: false })
    vi.stubGlobal('fetch', fetch)
    await adapter().writeBack('http://server/heresphere/1', { rating: 3, favourite: false, tags: ['anal'] })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ username: 'user', password: 'password', rating: 3 })
  })

  it('writes the favourite flag on its own, without touching the rating', async () => {
    const fetch = respondingServer({ rating: 0, isFavorite: false, tags: [], writeRating: false, writeFavorite: true })
    vi.stubGlobal('fetch', fetch)
    await adapter().writeBack('http://server/heresphere/1', { rating: 0, favourite: true, tags: [] })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ username: 'user', password: 'password', isFavorite: true })
  })

  it('rejects clearing a favourite when the server disables favourite updates', async () => {
    const fetch = respondingServer({ rating: 4, isFavorite: true, tags: [], writeFavorite: false })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().writeBack('http://server/heresphere/1', { rating: 4, favourite: false, tags: [] })).rejects.toThrow('does not allow favourite updates')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits for asynchronous updates without posting the mutation again', async () => {
    vi.useFakeTimers()
    let reads = 0
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body: Record<string, unknown> = JSON.parse(String(init.body))
      if (!('rating' in body)) reads++
      return Promise.resolve(Response.json({ rating: reads >= 3 ? 5 : 2, tags: [] }))
    })
    vi.stubGlobal('fetch', fetch)
    const result = adapter().writeBack('http://server/heresphere/1', { rating: 5, favourite: false, tags: [] })
    await vi.runAllTimersAsync()
    await result
    expect(fetch.mock.calls.filter((call) => 'rating' in JSON.parse(String(call[1]?.body)))).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it.each([
    { rating: 2, favourite: false, tags: ['new'], error: 'tag' },
    { rating: 5, favourite: false, tags: [], error: 'rating' },
    { rating: 2, favourite: true, tags: [], error: 'favourite' },
  ])('rejects permanently ignored $error updates after checking again', async ({ rating, favourite, tags, error }) => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ rating: 2, tags: [], writeTags: true })))
    vi.stubGlobal('fetch', fetch)
    const result = expect(adapter().writeBack('http://server/heresphere/1', { rating, favourite, tags })).rejects.toThrow(`did not save ${error} updates`)
    await vi.runAllTimersAsync()
    await result
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  it('rejects disabled rating updates', async () => {
    const fetch = respondingServer({ rating: 2, tags: [], writeRating: false })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().writeBack('http://server/heresphere/1', { rating: 3, favourite: false, tags: [] })).rejects.toThrow('does not allow rating updates')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

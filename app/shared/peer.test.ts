import { describe, expect, it } from 'vitest'
import { isRemoteMedia, mediaIdFromUrl, normaliseSource, syncRate } from './peer'

describe('normaliseSource', () => {
  it('adds the default port to a bare host', () => {
    expect(normaliseSource('192.168.1.5')).toBe('192.168.1.5:8420')
    expect(normaliseSource(' player.local ')).toBe('player.local:8420')
  })

  it('keeps an explicit port', () => {
    expect(normaliseSource('192.168.1.5:9000')).toBe('192.168.1.5:9000')
    expect(normaliseSource('[::1]:9000')).toBe('[::1]:9000')
  })

  it('drops the scheme, a path and a trailing slash', () => {
    expect(normaliseSource('http://192.168.1.5:8420/')).toBe('192.168.1.5:8420')
    expect(normaliseSource('http://player.local/deovr?x=1')).toBe('player.local:8420')
  })

  it('is empty for nothing usable', () => {
    expect(normaliseSource('')).toBe('')
    expect(normaliseSource('  ')).toBe('')
    expect(normaliseSource('http://')).toBe('')
  })
})

describe('mediaIdFromUrl', () => {
  it('reads the id of a served media URL', () => {
    expect(mediaIdFromUrl('http://192.168.1.5:8420/media/12')).toBe(12)
    expect(isRemoteMedia('http://192.168.1.5:8420/media/12')).toBe(true)
  })

  it('is null for files, other routes and other servers', () => {
    expect(mediaIdFromUrl('/videos/a.mp4')).toBeNull()
    expect(mediaIdFromUrl('http://192.168.1.5:8420/thumb/12')).toBeNull()
    expect(mediaIdFromUrl('http://stash.local/scene/12/stream')).toBeNull()
    expect(mediaIdFromUrl('http://192.168.1.5:8420/media/12/extra')).toBeNull()
  })
})

describe('syncRate', () => {
  it('sits on the source rate inside the deadband', () => {
    expect(syncRate(1, 0)).toBe(1)
    expect(syncRate(1.5, -3)).toBe(1.5)
  })

  it('slows when ahead and speeds up when behind, in proportion', () => {
    expect(syncRate(1, 40)).toBe(0.99)
    expect(syncRate(1, -40)).toBe(1.01)
    expect(syncRate(2, 40)).toBe(1.98)
  })

  it('caps the correction', () => {
    expect(syncRate(1, 1000)).toBe(0.95)
    expect(syncRate(1, -1000)).toBe(1.05)
  })
})

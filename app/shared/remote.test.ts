import { describe, expect, it } from 'vitest'
import { isUrl, serverPage } from './remote'

describe('serverPage', () => {
  it('maps a Stash stream to its scene page', () => {
    expect(serverPage('http://stash.local:9999/scene/42/stream')).toBe('http://stash.local:9999/scenes/42')
    expect(serverPage('https://stash.example.com/scene/7/stream?apikey=x')).toBe('https://stash.example.com/scenes/7')
  })

  it('is null for files and other servers', () => {
    expect(serverPage('/Volumes/media/clip.mp4')).toBeNull()
    expect(serverPage('http://xbvr.local:9999/api/dms/file/12')).toBeNull()
    expect(serverPage('http://host/media/3')).toBeNull()
  })
})

describe('isUrl', () => {
  it('accepts http and https only', () => {
    expect(isUrl('http://a/b')).toBe(true)
    expect(isUrl('HTTPS://a')).toBe(true)
    expect(isUrl('file:///a.mp4')).toBe(false)
    expect(isUrl('C:\\a.mp4')).toBe(false)
  })
})

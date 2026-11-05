import { describe, expect, it } from 'vitest'
import { basicAuth } from '@shared/peer'
import { authorised, keyMatches, passwordMatches, postedPassword, splitKey, urlKey } from './auth'

describe('authorised', () => {
  it('lets nobody in with no password set', () => {
    expect(authorised(undefined, '')).toBe(false)
    expect(authorised('Basic nonsense', '')).toBe(false)
    expect(authorised(basicAuth(''), '')).toBe(false)
  })

  it('needs the password under any user name', () => {
    expect(authorised(basicAuth('secret'), 'secret')).toBe(true)
    expect(authorised(`Basic ${Buffer.from('someone:secret').toString('base64')}`, 'secret')).toBe(true)
    expect(authorised(`Basic ${Buffer.from(':secret').toString('base64')}`, 'secret')).toBe(true)
  })

  it('refuses a missing, malformed or wrong header', () => {
    expect(authorised(undefined, 'secret')).toBe(false)
    expect(authorised('Bearer secret', 'secret')).toBe(false)
    expect(authorised(basicAuth('Secret'), 'secret')).toBe(false)
    expect(authorised(basicAuth('secre'), 'secret')).toBe(false)
  })
})

describe('postedPassword', () => {
  it('reads the password of a HereSphere sign-in', () => {
    expect(postedPassword({ username: 'anyone', password: 'secret' })).toBe('secret')
  })

  it('is null when the body signs nothing in', () => {
    for (const body of [undefined, null, [], 'secret', {}, { password: '' }, { password: 1 }]) expect(postedPassword(body)).toBeNull()
  })
})

describe('the URL key', () => {
  it('is stable for a password on an install, and differs with either', () => {
    const key = urlKey('secret', 'install')
    expect(keyMatches(urlKey('secret', 'install'), key)).toBe(true)
    expect(keyMatches(urlKey('other', 'install'), key)).toBe(false)
    expect(keyMatches(urlKey('secret', 'another'), key)).toBe(false)
    expect(key).not.toContain('secret')
  })

  it('lets nobody in with no password set', () => {
    expect(keyMatches('', '')).toBe(false)
    expect(passwordMatches('', '')).toBe(false)
  })

  it('splits off the path behind it', () => {
    expect(splitKey('/k/abc/media/7')).toEqual({ key: 'abc', path: '/media/7' })
    expect(splitKey('/k/abc')).toEqual({ key: 'abc', path: '/' })
    expect(splitKey('/media/7')).toEqual({ key: null, path: '/media/7' })
  })
})

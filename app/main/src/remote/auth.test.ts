import { describe, expect, it } from 'vitest'
import { basicAuth } from '@shared/peer'
import { authorised } from './auth'

describe('authorised', () => {
  it('lets everything through with no password set', () => {
    expect(authorised(undefined, '')).toBe(true)
    expect(authorised('Basic nonsense', '')).toBe(true)
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

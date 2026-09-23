import { describe, expect, it } from 'vitest'
import { migrate } from './store'

describe('game mode settings', () => {
  it('starts on a rhythm game with AI on and keeps a saved choice', () => {
    expect(migrate(null).game).toEqual({ kind: 'rhythm', ai: true })
    expect(migrate({ version: 1, game: { kind: 'motion', ai: false } }).game).toEqual({ kind: 'motion', ai: false })
  })
  it('drops a kind it does not know', () => {
    expect(migrate({ version: 1, game: { kind: 'puzzle', ai: 'yes' } }).game).toEqual({ kind: 'rhythm', ai: true })
  })
  it('preserves valid choices when another field is absent or invalid', () => {
    expect(migrate({ version: 1, game: { ai: false } }).game).toEqual({ kind: 'rhythm', ai: false })
    expect(migrate({ version: 1, game: { kind: 'motion', ai: null } }).game).toEqual({ kind: 'motion', ai: true })
  })
  it.each([undefined, null, [], 'motion', false])('defaults an invalid game section, %j', (game) => {
    expect(migrate({ version: 1, game }).game).toEqual({ kind: 'rhythm', ai: true })
  })
})

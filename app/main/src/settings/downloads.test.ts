import { describe, expect, it } from 'vitest'
import { migrate } from './store'

describe('remembered download library', () => {
  it('defaults safely for existing settings and persists the root identity', () => {
    expect(migrate({ version: 1 }).downloads.destination).toBeNull()
    const destination = { rootId: 6, relativePath: 'Scripts/VR' }
    expect(migrate({ version: 1, downloads: { destination } }).downloads.destination).toEqual(destination)
  })
  it('rejects malformed roots and paths', () => {
    for (const destination of [{ rootId: 0, relativePath: '' }, { rootId: 1, relativePath: '../out' }, { rootId: 1, relativePath: '/tmp' }, { rootId: 1, relativePath: 'a\\b' }]) {
      expect(migrate({ version: 1, downloads: { destination } }).downloads.destination).toBeNull()
    }
  })
})

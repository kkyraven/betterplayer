import { describe, expect, it } from 'vitest'
import { readShockers } from './openshock'

describe('readShockers', () => {
  it('flattens hubs into one list and keeps the pause state', () => {
    const shockers = readShockers({
      data: [
        { id: 'h1', name: 'Hub', shockers: [{ id: 'a', name: 'Left', model: 'CaiXianlin', isPaused: false }] },
        { id: 'h2', name: 'Spare', shockers: [{ id: 'b', name: 'Right', isPaused: true }] },
        { id: 'h3', name: 'Empty', shockers: [] },
      ],
    })
    expect(shockers).toEqual([
      { id: 'a', name: 'Left', hub: 'Hub', model: 'CaiXianlin', paused: false },
      { id: 'b', name: 'Right', hub: 'Spare', model: null, paused: true },
    ])
  })
})

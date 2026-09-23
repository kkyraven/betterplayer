import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ testOutput: vi.fn(), setLive: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./settings', () => ({ useSettings: {} }))
vi.mock('./live', () => ({}))
vi.mock('./account', () => ({ isPremium: () => false, useAccount: { getState: () => ({}), subscribe: vi.fn() } }))

import { testMove } from './devices'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout })
  vi.stubGlobal('requestAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('tests only the selected toy without changing global axes', async () => {
  engine.testOutput.mockReturnValue(true)
  const done = testMove({ id: 7, config: { kind: 'toy', profile: 'stroker', device: 'Nora', address: 'A' } })
  expect(engine.testOutput).toHaveBeenCalledWith(7)
  expect(requestAnimationFrame).not.toHaveBeenCalled()
  expect(engine.setLive).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3000)
  await done
})

it('does not sweep other outputs if the selected toy disconnects before testing', async () => {
  engine.testOutput.mockReturnValue(false)
  await testMove({ id: 7, config: { kind: 'toy', profile: 'stroker', device: 'Nora', address: 'A' } })
  expect(requestAnimationFrame).not.toHaveBeenCalled()
  expect(engine.setLive).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

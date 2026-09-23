import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))

afterEach(() => { vi.unstubAllGlobals() })

it.each([
  [null, 260],
  ['', 260],
  ['   ', 260],
  ['invalid', 260],
  ['310', 310],
  ['100', 160],
  ['500', 400],
])('restores thumbnail size %s as %s', async (stored, expected) => {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'library.gridSize' ? stored : null })
  const { useLibrary } = await import('./library')
  expect(useLibrary.getState().gridSize).toBe(expected)
})

it.each([
  [null, true],
  ['1', true],
  ['0', false],
  ['junk', true],
])('restores sidebar flag %s as %s', async (stored, expected) => {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'library.sidebar' ? stored : null })
  const { useLibrary } = await import('./library')
  expect(useLibrary.getState().sidebarOpen).toBe(expected)
})

import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), bundle: vi.fn(() => 'bundle'), json: vi.fn(() => 'sibling') }))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: {}, funscriptBundle: mocks.bundle, funscriptJson: mocks.json }))
vi.mock('./player', () => ({ usePlayer: { getState: () => ({ path: '/video.mp4', title: 'Video' }), subscribe: vi.fn() }, isUrl: () => false }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: 0 }), subscribe: vi.fn() }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({}) } }))
import { useEditor } from './editor'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue(null)
  useEditor.setState({
    key: 'video',
    durationMs: 1000,
    lanes: [
      {
        axis: 'S0',
        metadata: { creator: 'Author' },
        points: [
          { at: 0, pos: 0 },
          { at: 1000, pos: 75 },
        ],
      },
    ],
    chapters: [],
    bookmarks: [],
  })
})
it('preserves the axis and metadata of a shock-only bundle', async () => {
  await useEditor.getState().exportScripts('bundle')
  expect(mocks.bundle).toHaveBeenCalledWith(
    expect.objectContaining({ at: new Float64Array([0, 1000]), pos: new Float64Array([0, 0.75]), metadata: JSON.stringify({ creator: 'Author' }) }),
    [],
  )
  expect(mocks.invoke).toHaveBeenCalledWith('editor:export', '/video.mp4', 'Video', [{ suffix: 'shock', json: 'bundle' }])
})
it('exports a shock sibling with the dedicated suffix', async () => {
  await useEditor.getState().exportScripts('sibling')
  expect(mocks.invoke).toHaveBeenCalledWith('editor:export', '/video.mp4', 'Video', [{ suffix: 'shock', json: 'sibling' }])
})

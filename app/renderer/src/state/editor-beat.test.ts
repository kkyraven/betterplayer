import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BeatTrackInfo } from 'bp-engine'
import { defaultTrackAxes } from '@shared/tracking'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), analyse: vi.fn(), generate: vi.fn(),
  engine: { analyseCancel: vi.fn(), clearDraft: vi.fn(), analyseClose: vi.fn() },
  tracking: vi.fn(),
  settings: vi.fn(),
}))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: mocks.engine, beatAnalyseAsync: mocks.analyse, beatGenerate: mocks.generate }))
vi.mock('./player', () => ({ usePlayer: { getState: () => ({}), subscribe: vi.fn() }, isUrl: () => false }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: 0 }), subscribe: vi.fn() }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', () => ({ useSettings: { getState: mocks.settings } }))
vi.mock('./tracking', () => ({ useTracking: { getState: mocks.tracking } }))

let editor: typeof import('./editor').useEditor
const track: BeatTrackInfo = { beats: [0, 500, 1000, 1500], loudness: [0.5, 1, 0.5, 0.5], bpm: 120, durationMs: 2000, onset: [], onsetHopMs: 11.6, envelope: [], envelopeHopMs: 100 }

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  mocks.invoke.mockResolvedValue('/audio.f32')
  mocks.analyse.mockResolvedValue(track)
  mocks.generate.mockReturnValue([{ at: 500, pos: 10 }, { at: 800, pos: 90 }, { at: 1000, pos: 10 }])
  mocks.tracking.mockReturnValue({ beatTempoFactor: 0.5, axes: defaultTrackAxes() })
  mocks.settings.mockReturnValue({ settings: { tracking: { beatStyle: 'strokes', beatVolumeDepth: false, beatBounce: true, flourishes: true } } })
  editor = (await import('./editor')).useEditor
  editor.setState({ key: '/video.mp4', fps: 24, durationMs: 2000, focused: 'L0', lanes: [{ axis: 'L0', points: [{ at: 500, pos: 0 }, { at: 1000, pos: 0 }], metadata: {} }], selection: new Set([500, 1000]), ai: { source: 'beat', min: 10, max: 90, region: null, picking: false } })
})

afterEach(() => { editor.getState().close(); vi.unstubAllGlobals() })

it('uses the shared generator with surrounding beats, loudness, frame rate, range and tempo', async () => {
  await editor.getState().aiFill()
  expect(mocks.generate).toHaveBeenCalledWith(track, { style: 'strokes', volumeDepth: false, flourishes: true, bounceDepth: 1 / 6, bounceSpeed: 3, tempoFactor: 0.5, fps: 24, min: 10, max: 90, alternate: false })
  expect(editor.getState().ghost?.base).toEqual([[{ at: 500, pos: 10 }, { at: 800, pos: 90 }, { at: 1000, pos: 10 }]])
  expect(editor.getState().analysing).toBe(false)
})

it('shares in-flight analysis and discards it if the editor closes', async () => {
  let finish!: (track: BeatTrackInfo) => void
  mocks.analyse.mockReturnValue(new Promise<BeatTrackInfo>((resolve) => { finish = resolve }))
  const first = editor.getState().ensureBeats()
  const second = editor.getState().ensureBeats()
  await Promise.resolve()
  expect(mocks.analyse).toHaveBeenCalledTimes(1)
  editor.getState().close()
  finish(track)
  await Promise.all([first, second])
  expect(editor.getState().beatTrack).toBeNull()
})

it('respects the bottom bounce switch even when general flourishes are enabled', async () => {
  mocks.settings.mockReturnValue({ settings: { tracking: { beatBounce: false, flourishes: true } } })
  await editor.getState().aiFill()
  expect(mocks.generate).toHaveBeenCalledWith(track, expect.objectContaining({ flourishes: false }))
})

it('forwards custom bounce depth and speed to the editor generator', async () => {
  mocks.settings.mockReturnValue({ settings: { tracking: { beatBounce: true, beatBounceDepth: 0.4, beatBounceSpeed: 5.25, flourishes: true } } })
  await editor.getState().aiFill()
  expect(mocks.generate).toHaveBeenCalledWith(track, expect.objectContaining({ flourishes: true, bounceDepth: 0.4, bounceSpeed: 5.25 }))
})

it.each([0.5, 1, 2])('uses the Twist beat speed %s for editor fills', async (intensity) => {
  const axes = defaultTrackAxes()
  axes.R0 = { ...axes.R0, source: 'beat', intensity }
  mocks.tracking.mockReturnValue({ beatTempoFactor: 0.5, axes })
  editor.setState({ focused: 'R0', lanes: [{ ...editor.getState().lanes[0]!, axis: 'R0' }] })
  await editor.getState().aiFill()
  expect(mocks.generate).toHaveBeenCalledWith(track, expect.objectContaining({ tempoFactor: intensity * 0.5, alternate: true }))
})

it('leaves the document alone when a short or silent selection produces no strokes', async () => {
  mocks.generate.mockReturnValue([])
  await editor.getState().aiFill()
  expect(editor.getState().ghost).toBeNull()
  expect(editor.getState().message).toBeNull()
  expect(editor.getState().lanes[0]?.points).toEqual([{ at: 500, pos: 0 }, { at: 1000, pos: 0 }])
})

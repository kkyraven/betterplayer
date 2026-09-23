import { beforeEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { defaultParamSource, type ParamAxisId, type ParamSourceSettings } from '@shared/settings'

const state = vi.hoisted(() => ({
  wantsFrames: false,
  feedColour: vi.fn((_everyMs: () => number | null) => vi.fn()),
  refreshModels: vi.fn(),
  ensureAudio: vi.fn(async () => {}),
}))
const devices = createStore(() => ({ outputs: [{ config: { profile: 'restim', params: {} } }] }))
const settings = createStore(() => ({ settings: { estim: { params: true } } }))
const player = createStore(() => ({ path: 'video.mp4', video: { params: {} as Partial<Record<ParamAxisId, ParamSourceSettings>> } }))
const tracking = createStore(() => ({ source: null as 'player' | 'browser' | null, refreshModels: state.refreshModels }))
const browser = createStore(() => ({ activeId: 1 as number | null }))
vi.mock('@/engine/client', () => ({ engine: { wantsFrames: () => state.wantsFrames } }))
vi.mock('./devices', () => ({ useDevices: devices }))
vi.mock('./settings', () => ({ useSettings: settings }))
vi.mock('./player', () => ({ usePlayer: player }))
vi.mock('./tracking', () => ({ useTracking: tracking }))
vi.mock('./browser', () => ({ useBrowser: browser, feedColour: state.feedColour }))
vi.mock('./audio', () => ({ releaseAudio: vi.fn(), ensureAudio: state.ensureAudio }))

beforeEach(async () => {
  player.setState({ video: { params: {} } })
  tracking.setState({ source: null })
  state.wantsFrames = false
  await import('./paramFeeds')
  await Promise.resolve()
  vi.clearAllMocks()
})

it('feeds a video Detection override after the caller has pushed its source to the engine', async () => {
  player.setState({ video: { params: { P0: { ...defaultParamSource(), source: 'detection' } } } })
  const everyMs = state.feedColour.mock.calls[0]?.[0]
  expect(everyMs?.()).toBeNull()
  state.wantsFrames = true
  expect(everyMs?.()).toBeGreaterThan(0)
  expect(state.refreshModels).toHaveBeenCalledOnce()
  expect(state.feedColour).toHaveBeenCalledOnce()
  const stop = state.feedColour.mock.results[0]?.value
  tracking.setState({ source: 'browser' })
  await Promise.resolve()
  expect(stop).toHaveBeenCalledOnce()
})

it('analyses audio for a per-video P1 source with no output source configured', async () => {
  player.setState({ video: { params: { P1: { ...defaultParamSource(), source: 'audio' } } } })
  await Promise.resolve()
  expect(state.ensureAudio).toHaveBeenCalledWith('video.mp4', 'parameters')
})

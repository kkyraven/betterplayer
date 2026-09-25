import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ui: { screen: 'library', stripHiddenFor: null as string | null },
  player: { path: '/video.mp4' as string | null, snapshot: { loaded: true, paused: false }, togglePlay: vi.fn(), seekBy: vi.fn(), stepBookmark: vi.fn() },
  editor: { open: false, togglePlay: vi.fn() },
}))
vi.mock('@/engine/client', () => ({ enhanceCapabilities: {} }))
vi.mock('@/state/gapSkip', () => ({ skipGap: vi.fn() }))
vi.mock('@/state/editor', () => ({ useEditor: { getState: () => state.editor } }))
vi.mock('@/state/player', () => ({ usePlayer: { getState: () => state.player } }))
vi.mock('@/state/session', () => ({ useSession: { getState: () => ({}) } }))
vi.mock('@/state/settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('@/state/i18n', () => ({ t: (key: string) => key }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => state.ui } }))

import { captureNext, dispatch, setBindings } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  state.ui.screen = 'library'
  state.ui.stripHiddenFor = null
  state.player.path = '/video.mp4'
  state.player.snapshot.paused = false
  state.player.snapshot.loaded = true
  state.editor.open = false
  setBindings({ space: 'Media.PlayPause.Toggle', 'editor:space': 'Editor.Play.Toggle', arrowright: 'Media.Seek.Forward' })
})

it.each(['library', 'settings', 'devices', 'session', 'browser', 'player'])('toggles loaded media from %s', (screen) => {
  state.ui.screen = screen
  expect(dispatch('space')).toBe(true)
  expect(state.player.togglePlay).toHaveBeenCalledOnce()
})

it('does not consume Space without loaded media', () => {
  state.player.snapshot.loaded = false
  expect(dispatch('space')).toBe(false)
  expect(state.player.togglePlay).not.toHaveBeenCalled()
})

it('does not resume paused media when its miniplayer is hidden', () => {
  state.player.snapshot.paused = true
  state.ui.stripHiddenFor = state.player.path
  expect(dispatch('space')).toBe(false)
  expect(state.player.togglePlay).not.toHaveBeenCalled()
})

it('can pause playing media with its miniplayer hidden', () => {
  state.ui.stripHiddenFor = state.player.path
  expect(dispatch('space')).toBe(true)
  expect(state.player.togglePlay).toHaveBeenCalledOnce()
})

it('can resume paused media with its miniplayer open or full player visible', () => {
  state.player.snapshot.paused = true
  expect(dispatch('space')).toBe(true)
  state.ui.stripHiddenFor = state.player.path
  state.ui.screen = 'player'
  expect(dispatch('space')).toBe(true)
  expect(state.player.togglePlay).toHaveBeenCalledTimes(2)
})

it('keeps seek shortcuts scoped to the player screen', () => {
  expect(dispatch('arrowright')).toBe(false)
  state.ui.screen = 'player'
  expect(dispatch('arrowright')).toBe(true)
  expect(state.player.seekBy).toHaveBeenCalledExactlyOnceWith(4)
})

it('preserves editor Space and leaves the empty editor alone', () => {
  state.ui.screen = 'editor'
  expect(dispatch('space')).toBe(false)
  state.editor.open = true
  expect(dispatch('space')).toBe(true)
  expect(state.editor.togglePlay).toHaveBeenCalledOnce()
  expect(state.player.togglePlay).not.toHaveBeenCalled()
})

it('respects rebinding and shortcut capture', () => {
  setBindings({ w: 'Media.PlayPause.Toggle' })
  expect(dispatch('space')).toBe(false)
  const capture = vi.fn()
  const cancel = captureNext(capture)
  expect(dispatch('space')).toBe(true)
  expect(capture).toHaveBeenCalledExactlyOnceWith('space')
  expect(state.player.togglePlay).not.toHaveBeenCalled()
  cancel()
})

it('dispatches bookmark shortcuts only on the loaded player', () => {
  setBindings({ pageup: 'Media.Bookmark.Previous', pagedown: 'Media.Bookmark.Next' })
  expect(dispatch('pageup')).toBe(false)
  state.ui.screen = 'player'
  expect(dispatch('pageup')).toBe(true)
  expect(state.player.stepBookmark).toHaveBeenLastCalledWith(-1)
  expect(dispatch('pagedown')).toBe(true)
  expect(state.player.stepBookmark).toHaveBeenLastCalledWith(1)
  state.player.snapshot.loaded = false
  expect(dispatch('pagedown')).toBe(false)
  expect(state.player.stepBookmark).toHaveBeenCalledTimes(2)
})

import { beforeEach, expect, it, vi } from 'vitest'
const ui = vi.hoisted(() => ({ mediaCentre: false, setScreen: vi.fn() }))
vi.mock('./ui', () => ({ useUi: { getState: () => ui } }))
import { useAccountNavigation } from './accountNavigation'
import { openSettings, useSettingsNavigation } from './settingsNavigation'
import { searchSettings, settingsSearchIndex } from '@/screens/settings/search'

beforeEach(() => {
  useSettingsNavigation.setState(useSettingsNavigation.getInitialState(), true)
  useAccountNavigation.setState(useAccountNavigation.getInitialState(), true)
  ui.mediaCentre = false
  ui.setScreen.mockClear()
})
it('starts on General and remembers each category without persisting app settings', () => {
  const nav = useSettingsNavigation.getState()
  expect(nav.page).toBe('appearance')
  nav.selectPage('subtitles')
  nav.selectCategory('motion')
  expect(useSettingsNavigation.getState().page).toBe('devices')
  nav.selectCategory('playback')
  expect(useSettingsNavigation.getState().page).toBe('subtitles')
})
it('reveals advanced results and retains query and disclosure state through return', () => {
  const nav = useSettingsNavigation.getState()
  nav.setQuery('Hardware decode')
  const result = searchSettings('Hardware decode')[0]!
  nav.reveal(result)
  expect(useSettingsNavigation.getState()).toMatchObject({ page: 'video', query: 'Hardware decode', target: 'hardware-decode', results: false, disclosures: { video: true } })
  nav.back()
  expect(useSettingsNavigation.getState().results).toBe(true)
  nav.setQuery('')
  expect(useSettingsNavigation.getState()).toMatchObject({ page: 'video', disclosures: { video: true } })
})
it('returns from a cross-link to its invoking page and focus target', () => {
  const nav = useSettingsNavigation.getState()
  nav.selectPage('tracking')
  nav.selectPage('models', undefined, false, true)
  nav.back()
  expect(useSettingsNavigation.getState()).toMatchObject({ page: 'tracking', target: 'link-models', history: [] })
})
it('reopens dismissed axis sections when revealing an advanced search result', () => {
  const nav = useSettingsNavigation.getState()
  nav.toggleAdvanced('axes:L0', false)
  nav.toggleAdvanced('axes:R0', false)
  nav.toggleAdvanced('estim:L0', false)
  const result = settingsSearchIndex().find((setting) => setting.page === 'axes' && setting.advanced)!
  nav.reveal(result)
  expect(useSettingsNavigation.getState().disclosures).toMatchObject({
    axes: true,
    'axes:L0': true,
    'axes:R0': true,
    'estim:L0': false,
  })
  nav.toggleAdvanced('axes:L0', false)
  expect(useSettingsNavigation.getState().disclosures['axes:L0']).toBe(false)
})
it('ranks exact labels above paths and aliases with stable results', () => {
  expect(searchSettings('Hardware decode')[0]).toMatchObject({ page: 'video', advanced: true })
  expect(searchSettings('Headsets')[0]).toMatchObject({ page: 'headsets' })
  expect(searchSettings('Axes')[0]).toMatchObject({ page: 'axes' })
  expect(searchSettings('playback hardware')[0]).toMatchObject({ page: 'video' })
  expect(searchSettings('no such setting')).toEqual([])
  expect(searchSettings('  ')).toEqual([])
})
it('indexes labels only and gives every destination a unique target', () => {
  const index = settingsSearchIndex()
  expect(new Set(index.map((s) => `${s.page}:${s.id}`)).size).toBe(index.length)
  expect(JSON.stringify(index)).not.toMatch(/password|token|sourcePassword|localhost|@/i)
})

it.each(['Bounce depth', 'Bounce speed'])('finds %s in Beat settings', (label) => {
  expect(searchSettings(label)[0]).toMatchObject({ page: 'tracking', label, advanced: false })
})

it('returns through cross-links before retained search results and remembers the returned child', () => {
  const nav = useSettingsNavigation.getState()
  nav.setQuery('tracking')
  nav.selectPage('tracking')
  nav.selectPage('models', undefined, false, true)
  nav.back()
  expect(useSettingsNavigation.getState()).toMatchObject({ page: 'tracking', results: false, lastPages: { motion: 'tracking' } })
  nav.back()
  expect(useSettingsNavigation.getState().results).toBe(true)
})


it('opens desktop account links over the current screen and preserves their field target', () => {
  for (const page of ['profile', 'friends', 'privacy'] as const) {
    openSettings(page, 'field')
    expect(useAccountNavigation.getState()).toMatchObject({ open: true, page, target: 'field' })
    expect(useSettingsNavigation.getState().page).toBe('appearance')
    useAccountNavigation.getState().close()
  }
  expect(ui.setScreen).not.toHaveBeenCalled()
})

it('reveals account search results in the panel without losing the search behind it', () => {
  const nav = useSettingsNavigation.getState()
  nav.setQuery('Display name')
  nav.reveal({ page: 'profile', id: 'display-name', label: 'Display name', aliases: [] })
  expect(useAccountNavigation.getState()).toMatchObject({ open: true, page: 'profile', target: 'display-name' })
  expect(useSettingsNavigation.getState()).toMatchObject({ query: 'Display name', results: true })
  useAccountNavigation.getState().close()
  useAccountNavigation.getState().show()
  expect(useAccountNavigation.getState()).toMatchObject({ page: 'home', target: null })
})

it('keeps support in Settings and retains account settings navigation for the media centre', () => {
  openSettings('support')
  expect(useSettingsNavigation.getState().page).toBe('support')
  expect(ui.setScreen).toHaveBeenCalledWith('settings')
  expect(useAccountNavigation.getState().open).toBe(false)
  ui.mediaCentre = true
  openSettings('profile')
  expect(useSettingsNavigation.getState().page).toBe('profile')
  expect(useAccountNavigation.getState().open).toBe(false)
})

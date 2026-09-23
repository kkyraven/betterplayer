import { afterEach, expect, it, vi } from 'vitest'
import { createTranslator, DEFAULT_LOCALE, ENGLISH } from '@shared/i18n'
import { defaultSettings } from '@shared/settings'

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/ipc', () => ipc)
vi.mock('./ui', () => ({ useUi: { getState: () => ({ screen: 'library', setReduceTransparency: vi.fn() }) } }))
import { setLanguage, useI18n } from './i18n'
import { useSettings } from './settings'

afterEach(() => {
  useI18n.setState({ locale: DEFAULT_LOCALE, t: createTranslator(DEFAULT_LOCALE, ENGLISH) })
  vi.unstubAllGlobals()
})

it('translates the welcome page before the language preference finishes saving', async () => {
  vi.stubGlobal('window', { clearTimeout })
  vi.stubGlobal('document', { documentElement: { lang: 'en' } })
  let finishSave = () => {}
  ipc.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve }))
  useSettings.setState({ settings: defaultSettings() })
  const save = useSettings.getState().update((s) => ({ ...s, general: { ...s.general, language: 'de' } }))
  try {
    await vi.waitFor(() => expect(useI18n.getState().t('firstStart.welcome.start')).toBe('Loslegen'))
    expect(document.documentElement.lang).toBe('de')
    expect(ipc.invoke).toHaveBeenCalledWith('settings:set', expect.objectContaining({ general: expect.objectContaining({ language: 'de' }) }))
  } finally {
    finishSave()
    await save
  }
})

it('keeps the latest language when choices change while translations load', async () => {
  vi.stubGlobal('document', { documentElement: { lang: 'en' } })
  await Promise.all([setLanguage('ja'), setLanguage('fr')])
  expect(useI18n.getState().locale).toBe('fr')
  expect(useI18n.getState().t('firstStart.welcome.start')).toBe('Commencer')
  await Promise.all([setLanguage('de'), setLanguage('en')])
  expect(useI18n.getState().t('firstStart.welcome.start')).toBe('Get started')
})

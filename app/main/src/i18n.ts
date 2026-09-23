import { app } from 'electron'
import { createTranslator, DEFAULT_LOCALE, ENGLISH, loadMessages, resolveLocale, type Translate } from '@shared/i18n'
import type { SettingsStore } from './settings/store'

let current: Translate = createTranslator(DEFAULT_LOCALE, ENGLISH)

export const t: Translate = (key, params) => current(key, params)

export async function syncLanguage(store: SettingsStore) {
  const locale = resolveLocale(app.getPreferredSystemLanguages(), store.get().general.language)
  current = createTranslator(locale, await loadMessages(locale))
}

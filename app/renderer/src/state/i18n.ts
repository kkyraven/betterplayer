import { create } from 'zustand'
import { createTranslator, DEFAULT_LOCALE, ENGLISH, isLanguagePreference, loadMessages, resolveLocale, type LanguagePreference, type Locale, type Translate } from '@shared/i18n'

interface I18nState {
  locale: Locale
  t: Translate
}

export const useI18n = create<I18nState>()(() => ({ locale: DEFAULT_LOCALE, t: createTranslator(DEFAULT_LOCALE, ENGLISH) }))

export const useT = () => useI18n((s) => s.t)

export const t: Translate = (key, params) => useI18n.getState().t(key, params)

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--bp-${name}=`))?.slice(`--bp-${name}=`.length)

const system = (arg('languages') ?? '').split(',').filter(Boolean)
export const SYSTEM_LOCALE = resolveLocale(system, 'auto')

let generation = 0

export async function setLanguage(preference: LanguagePreference) {
  const locale = resolveLocale(system, preference)
  const own = ++generation
  if (locale === useI18n.getState().locale) return
  const messages = await loadMessages(locale)
  if (own !== generation) return
  useI18n.setState({ locale, t: createTranslator(locale, messages) })
  document.documentElement.lang = locale
}

export function startI18n() {
  const saved = arg('language')
  return setLanguage(isLanguagePreference(saved) ? saved : 'auto')
}

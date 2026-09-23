import en from './en/base.json'

export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>
export type Message = string | PluralForms
export type MessageKey = keyof typeof en
export type Messages = Partial<Record<MessageKey, Message>>
export type Params = Record<string, string | number>
export type Translate = (key: MessageKey, params?: Params) => string

export const ENGLISH: Messages = en

export const LOCALES = {
  en: () => Promise.resolve(ENGLISH),
  'zh-Hans': () => import('./zh-Hans/base.json').then((m) => m.default),
  'zh-Hant': () => import('./zh-Hant/base.json').then((m) => m.default),
  'ja': () => import('./ja/base.json').then((m) => m.default),
  'ar': () => import('./ar/base.json').then((m) => m.default),
  'ko': () => import('./ko/base.json').then((m) => m.default),
  'es-ES': () => import('./es-ES/base.json').then((m) => m.default),
  'es-419': () => import('./es-419/base.json').then((m) => m.default),
  'es-AR': () => import('./es-AR/base.json').then((m) => m.default),
  'hi': () => import('./hi/base.json').then((m) => m.default),
  'fr': () => import('./fr/base.json').then((m) => m.default),
  'pt-BR': () => import('./pt-BR/base.json').then((m) => m.default),
  'ru': () => import('./ru/base.json').then((m) => m.default),
  'de': () => import('./de/base.json').then((m) => m.default),
  'vi': () => import('./vi/base.json').then((m) => m.default),
  'tr': () => import('./tr/base.json').then((m) => m.default),
  'fa': () => import('./fa/base.json').then((m) => m.default),
  'it': () => import('./it/base.json').then((m) => m.default),
  'th': () => import('./th/base.json').then((m) => m.default),
  'pl': () => import('./pl/base.json').then((m) => m.default),
  'uk': () => import('./uk/base.json').then((m) => m.default),
  'ms-MY': () => import('./ms-MY/base.json').then((m) => m.default),
  'ro': () => import('./ro/base.json').then((m) => m.default),
  'nl': () => import('./nl/base.json').then((m) => m.default),
  'el': () => import('./el/base.json').then((m) => m.default),
  'hu': () => import('./hu/base.json').then((m) => m.default),
  'cs': () => import('./cs/base.json').then((m) => m.default),
  'sv': () => import('./sv/base.json').then((m) => m.default),
  'he': () => import('./he/base.json').then((m) => m.default),
  'sk': () => import('./sk/base.json').then((m) => m.default),
  'lt': () => import('./lt/base.json').then((m) => m.default),
  'ga': () => import('./ga/base.json').then((m) => m.default),
  'sco': () => import('./sco/base.json').then((m) => m.default),
  'yue-Hant': () => import('./yue-Hant/base.json').then((m) => m.default),
} as const satisfies Record<string, () => Promise<Messages>>
export type Locale = keyof typeof LOCALES
export const loadMessages = (locale: Locale): Promise<Messages> => LOCALES[locale]()
export const LOCALE_IDS = Object.keys(LOCALES) as readonly Locale[]
export const DEFAULT_LOCALE = 'en' satisfies Locale

export type LanguagePreference = 'auto' | Locale
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['auto', ...LOCALE_IDS]
export const isLanguagePreference = (v: unknown): v is LanguagePreference => LANGUAGE_PREFERENCES.some((p) => p === v)
export const LANGUAGE_CHOICE = LOCALE_IDS.length > 1

export function languageName(locale: Locale): string {
  const names: Partial<Record<Locale, string>> = { ga: 'Gaeilge', sco: 'Scots', 'yue-Hant': '廣東話' }
  const name = names[locale] ?? new Intl.DisplayNames(locale, { type: 'language' }).of(locale) ?? locale
  const native = name.replace(/^./u, (first) => first.toLocaleUpperCase(locale))
  const english = new Intl.DisplayNames('en', { type: 'language', fallback: 'none' }).of(locale) ?? native
  return native === english ? native : `${native} (${english})`
}

function canonical(tag: string): string | null {
  try {
    return new Intl.Locale(tag.trim().replace(/_/g, '-')).baseName
  } catch {
    return null
  }
}

export function matchLocale<L extends string>(system: readonly string[], available: readonly L[]): L | undefined {
  const has = (tag: string): tag is L => available.some((id) => id === tag)
  for (const raw of system) {
    const tag = canonical(raw)
    if (!tag) continue
    const parts = tag.split('-')
    for (let n = parts.length; n > 0; n--) {
      const candidate = parts.slice(0, n).join('-')
      if (has(candidate)) return candidate
    }
    const { language, script } = new Intl.Locale(tag).maximize()
    const withScript = `${language}-${script}`
    if (has(withScript)) return withScript
    const sameLanguage = available.find((id) => id.split('-')[0] === parts[0])
    if (sameLanguage) return sameLanguage
  }
  return undefined
}

export function resolveLocale(system: readonly string[], preference: LanguagePreference): Locale {
  if (preference !== 'auto') return preference
  return matchLocale(system, LOCALE_IDS) ?? DEFAULT_LOCALE
}

export function fill(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => (name in params ? String(params[name]) : slot))
}

export function createTranslator(locale: Locale, messages: Messages): Translate {
  const rules = new Intl.PluralRules(locale)
  return (key, params) => {
    const message = messages[key] ?? ENGLISH[key]
    if (message === undefined) return key
    if (typeof message === 'string') return fill(message, params)
    const count = params?.count
    const form = typeof count === 'number' ? (message[rules.select(count)] ?? message.other) : message.other
    return fill(form, params)
  }
}

import { describe, expect, it } from 'vitest'
import { createTranslator, fill, languageName, loadMessages, LOCALE_IDS, matchLocale, resolveLocale } from './index'

describe('matchLocale', () => {
  const available = ['en', 'pt-BR', 'zh-Hant', 'de'] as const
  it('takes the exact tag, then shorter prefixes', () => {
    expect(matchLocale(['pt-BR'], available)).toBe('pt-BR')
    expect(matchLocale(['de-AT'], available)).toBe('de')
    expect(matchLocale(['zh-Hant-TW'], available)).toBe('zh-Hant')
  })
  it('falls to a locale in the same language before moving down the list', () => {
    expect(matchLocale(['pt-PT', 'en-GB'], available)).toBe('pt-BR')
  })
  it('canonicalises what the OS sends', () => {
    expect(matchLocale(['pt_br'], available)).toBe('pt-BR')
    expect(matchLocale(['zh-hant-tw'], available)).toBe('zh-Hant')
    expect(matchLocale(['en-AU-u-ca-gregory'], available)).toBe('en')
  })
  it('skips bad tags and reports no match', () => {
    expect(matchLocale(['', '!!', 'fr-FR'], available)).toBeUndefined()
    expect(matchLocale(['!!', 'de'], available)).toBe('de')
  })
  it('detects the Chinese script when the system only provides a region', () => {
    expect(matchLocale(['zh-TW'], ['zh-Hans', 'zh-Hant'])).toBe('zh-Hant')
    expect(matchLocale(['zh-HK'], ['zh-Hans', 'zh-Hant'])).toBe('zh-Hant')
    expect(matchLocale(['zh-CN'], ['zh-Hans', 'zh-Hant'])).toBe('zh-Hans')
  })
})

describe('resolveLocale', () => {
  it('honours an explicit choice and falls back to English', () => {
    expect(resolveLocale(['fr-FR'], 'en')).toBe('en')
    expect(resolveLocale(['fr-FR'], 'auto')).toBe('fr')
    expect(resolveLocale(['xx-XX'], 'auto')).toBe('en')
    expect(resolveLocale([], 'auto')).toBe('en')
  })
})

it('lists the requested languages first and loads their welcome translations', async () => {
  expect(LOCALE_IDS.slice(0, 6)).toEqual(['en', 'zh-Hans', 'zh-Hant', 'ja', 'ar', 'ko'])
  for (const locale of LOCALE_IDS) {
    const messages = await loadMessages(locale)
    expect(messages['firstStart.welcome.title']).toBeTypeOf('string')
    expect(messages['firstStart.welcome.start']).toBeTypeOf('string')
  }
  expect(languageName('ga')).toBe('Gaeilge (Irish)')
})

describe('createTranslator', () => {
  const key = 'settings.appearance.language'
  it('fills slots and leaves an unfilled one visible', () => {
    expect(fill('{n} of {total}', { n: 2, total: 5 })).toBe('2 of 5')
    expect(fill('{n} of {total}', { n: 2 })).toBe('2 of {total}')
  })
  it('reads English for a key the locale lacks, and the key when English lacks it too', () => {
    const t = createTranslator('en', {})
    expect(t(key)).toBe('Language')
    expect(t('missing.key' as typeof key)).toBe('missing.key')
  })
  it('picks the plural form from count', () => {
    const t = createTranslator('en', { [key]: { one: '{count} language', other: '{count} languages' } })
    expect(t(key, { count: 1 })).toBe('1 language')
    expect(t(key, { count: 3 })).toBe('3 languages')
    expect(t(key)).toBe('{count} languages')
  })
})

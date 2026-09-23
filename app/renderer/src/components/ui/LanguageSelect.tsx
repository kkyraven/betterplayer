import { LOCALE_IDS, languageName, type LanguagePreference } from '@shared/i18n'
import { SYSTEM_LOCALE, useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { Select } from './Select'

export function LanguageSelect({ className }: { className?: string }) {
  const t = useT()
  const language = useSettings((s) => s.settings?.general.language ?? 'auto')
  const update = useSettings((s) => s.update)
  const options: { value: LanguagePreference; label: string }[] = [
    { value: 'auto', label: `${languageName(SYSTEM_LOCALE)} · ${t('settings.appearance.language.system')}` },
    ...LOCALE_IDS.map((value) => ({ value, label: languageName(value) })),
  ]
  return (
    <Select
      className={className}
      label={t('settings.appearance.language')}
      options={options}
      value={language}
      onChange={(language) => void update((s) => ({ ...s, general: { ...s.general, language } }))}
    />
  )
}

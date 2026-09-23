import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useT } from '@/state/i18n'
import { useSettingsFeedback } from '@/state/settingsFeedback'
import { useSettingsNavigation } from '@/state/settingsNavigation'
import { PAGE_LABELS, type SettingsPageId } from './navigation'

export function SettingsAdvanced({ page, id, custom = false, error, children }: { page: SettingsPageId; id?: string; custom?: boolean; error?: string; children: ReactNode }) {
  const t = useT()
  const errors = useSettingsFeedback((s) => s.errors)
  const failed = Object.values(errors).some((value) => value.edit.page === page)
  const key = id ? `${page}:${id}` : page
  const open = useSettingsNavigation((s) => s.disclosures[key] ?? s.disclosures[page] ?? false)
  const toggle = useSettingsNavigation((s) => s.toggleAdvanced)
  const bodyId = useId()
  return (
    <section className="settings-advanced" data-setting="advanced" tabIndex={-1} aria-label={t('settings.screen.advanced')}>
      <button type="button" className="settings-disclosure" aria-expanded={open} aria-controls={bodyId} onClick={() => toggle(key, !open)}>
        {open ? <ChevronDown /> : <ChevronRight />} {t('settings.screen.advanced')} <span className="spacer" />
        {(failed || error) && <span className="error">{error ?? t('settings.section.saveFailed')}</span>}
        {custom && <span className="settings-badge">{t('settings.section.custom')}</span>}
      </button>
      {open && (
        <div id={bodyId} className="settings-advanced-body">
          {children}
        </div>
      )}
    </section>
  )
}

export function SettingsLink({ page, label, detail, advanced = false }: { page: SettingsPageId; label?: string; detail?: string | null; advanced?: boolean }) {
  const t = useT()
  return (
    <button
      type="button"
      className="settings-link"
      data-setting={`link-${page}`}
      onClick={() => useSettingsNavigation.getState().selectPage(page, advanced ? 'advanced' : undefined, advanced, true)}
    >
      <span>
        {label ?? t(PAGE_LABELS[page])}
        {detail && <span className="sub">{detail}</span>}
      </span>
      <ChevronRight />
    </button>
  )
}

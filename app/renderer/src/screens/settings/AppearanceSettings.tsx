import { Lock } from 'lucide-react'
import { useState } from 'react'
import { SUBSCRIBE_URL } from '@shared/account'
import { LANGUAGE_CHOICE } from '@shared/i18n'
import { ACCENTS, THEME_MODES, TINTS, accentColour, defaultTheme, effectiveTheme, resolveMode, type ThemeSettings } from '@shared/theme'
import { Button } from '@/components/ui/Button'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { LanguageSelect } from '@/components/ui/LanguageSelect'
import { Swatches } from '@/components/ui/Swatches'
import { Switch } from '@/components/ui/Switch'
import { electron } from '@/node'
import { isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useSystemDark } from '@/state/theme'

export function AppearanceSettings() {
  const t = useT()
  const reduce = useSettings((s) => s.settings?.appearance.reduceTransparency) ?? false
  const startInMediaCentre = useSettings((s) => s.settings?.appearance.startInMediaCentre) ?? false
  const saved = useSettings((s) => s.settings?.appearance.theme) ?? defaultTheme()
  const continueRow = useSettings((s) => s.settings?.library.continueRow) ?? false
  const axisBadges = useSettings((s) => s.settings?.library.axisBadges) ?? true
  const update = useSettings((s) => s.update)
  const locked = !useAccount(isPremium)
  const systemDark = useSystemDark()
  const [asking, setAsking] = useState(false)
  const theme = effectiveTheme(saved, locked)
  const mode = resolveMode(theme.mode, systemDark)
  const setTheme = (change: Partial<ThemeSettings>) => void update((s) => ({ ...s, appearance: { ...s.appearance, theme: { ...s.appearance.theme, ...change } } }))
  const modes = THEME_MODES.map((value) => ({ value, label: t(`settings.appearance.mode.${value}`) }))
  const accents = ACCENTS.map((value) => ({ value, label: t(`settings.appearance.accent.${value}`), colour: accentColour(value, mode) }))
  const tints = TINTS.map((value) => (value === 'none' ? { value, label: t('common.none'), colour: null } : { value, label: t(`settings.appearance.accent.${value}`), colour: accentColour(value, mode) }))
  return (
    <div className="set-appearance">
      <div className="panel">
        {LANGUAGE_CHOICE && (
          <div className="prow">
            <span className="lbl">{t('settings.appearance.language')}</span>
            <span className="spacer" />
            <LanguageSelect />
          </div>
        )}
        <div className="prow">
          <span className="lbl">{t('settings.appearance.mode')}</span>
          <span className="spacer" />
          <Segmented options={modes} value={theme.mode} onChange={(mode) => setTheme({ mode })} label={t('settings.appearance.mode')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.appearance.reduceTransparency')}</span>
          <span className="spacer" />
          <Switch checked={reduce} onCheckedChange={(reduceTransparency) => void update((s) => ({ ...s, appearance: { ...s.appearance, reduceTransparency } }))} label={t('settings.appearance.reduceTransparency')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.appearance.startInMediaCentre')}</span>
          <span className="spacer" />
          <Switch checked={startInMediaCentre} onCheckedChange={(startInMediaCentre) => void update((s) => ({ ...s, appearance: { ...s.appearance, startInMediaCentre } }))} label={t('settings.appearance.startInMediaCentre')} />
        </div>
      </div>
      {locked && <Button onClick={() => setAsking(true)}>{t('common.supporterOnly')}</Button>}
      <span className="eyebrow">
        {t('settings.appearance.theme')}
        {locked && <Lock aria-label={t('common.supporterOnly')} />}
      </span>
      <div className="panel" inert={locked}>
        <div className="prow">
          <span className="lbl">{t('settings.appearance.accent')}</span>
          <span className="spacer" />
          <Swatches options={accents} value={theme.accent} onChange={(accent) => setTheme({ accent })} label={t('settings.appearance.accent')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.appearance.tint')}</span>
          <span className="spacer" />
          <Swatches options={tints} value={theme.tint} onChange={(tint) => setTheme({ tint })} label={t('settings.appearance.tint')} />
        </div>
      </div>
      <span className="eyebrow">{t('settings.category.library')}</span>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.appearance.continueRow')}</span>
          <span className="spacer" />
          <Switch checked={continueRow} onCheckedChange={(continueRow) => void update((s) => ({ ...s, library: { ...s.library, continueRow } }))} label={t('settings.appearance.continueRow')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.appearance.axisBadges')}</span>
          <span className="spacer" />
          <Switch checked={axisBadges} onCheckedChange={(axisBadges) => void update((s) => ({ ...s, library: { ...s.library, axisBadges } }))} label={t('settings.appearance.axisBadges')} />
        </div>
      </div>
      <Prompt
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.appearance.theme')}
        body={t('settings.appearance.themePromptBody')}
        cancelLabel={t('common.close')}
        confirmLabel={t('common.upgrade')}
        onConfirm={() => void electron.shell.openExternal(SUBSCRIBE_URL)}
      />
    </div>
  )
}

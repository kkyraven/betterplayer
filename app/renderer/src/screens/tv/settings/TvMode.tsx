import { TvRow } from '@/components/tv/TvRow'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

export function TvModeGroup() {
  const t = useT()
  const startInMediaCentre = useSettings((s) => s.settings?.appearance.startInMediaCentre ?? false)
  const reduce = useSettings((s) => s.settings?.appearance.reduceTransparency ?? false)
  const hints = useSettings((s) => s.settings?.tv.hints ?? true)
  const backdrop = useSettings((s) => s.settings?.tv.backdrop ?? false)
  const continueRow = useSettings((s) => s.settings?.library.continueRow ?? false)
  const update = useSettings((s) => s.update)
  return (
    <>
      <TvRow kind="switch" label={t('tv.tvMode.startInTvMode')} navFirst value={startInMediaCentre} onChange={(startInMediaCentre) => void update((s) => ({ ...s, appearance: { ...s.appearance, startInMediaCentre } }))} />
      <TvRow kind="switch" label={t('settings.appearance.reduceTransparency')} value={reduce} onChange={(reduceTransparency) => void update((s) => ({ ...s, appearance: { ...s.appearance, reduceTransparency } }))} />
      <TvRow kind="switch" label={t('tv.tvMode.buttonHints')} value={hints} onChange={(hints) => void update((s) => ({ ...s, tv: { ...s.tv, hints } }))} />
      <TvRow kind="switch" label={t('tv.tvMode.backdrop')} sub={t('tv.tvMode.backdropSub')} value={backdrop} onChange={(backdrop) => void update((s) => ({ ...s, tv: { ...s.tv, backdrop } }))} disabled={reduce} />
      <TvRow kind="switch" label={t('settings.appearance.continueRow')} value={continueRow} onChange={(continueRow) => void update((s) => ({ ...s, library: { ...s.library, continueRow } }))} />
    </>
  )
}

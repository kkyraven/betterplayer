import { TCODE_AXES, type AxisId } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import { defaultAxisSettings } from '@shared/settings'
import { TvRow } from '@/components/tv/TvRow'
import { setAxisDefault } from '@/state/axisDefaults'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

const pct = (v: number) => `${Math.round(v * 100)}%`

export function AxesGroup() {
  return (
    <>
      {TCODE_AXES.map((a, i) => (
        <AxisRows key={a.id} id={a.id} name={a.name} first={i === 0} />
      ))}
    </>
  )
}

function AxisRows({ id, name, first }: { id: AxisId; name: MessageKey; first: boolean }) {
  const t = useT()
  const s = useSettings((st) => st.settings?.axesDefault[id]) ?? defaultAxisSettings(id)
  const set = (patch: Parameters<typeof setAxisDefault>[1]) => setAxisDefault(id, patch, true)
  return (
    <>
      <span className="eyebrow tv-rows-eyebrow">
        {t(name)} {id}
      </span>
      <TvRow kind="switch" label={t('tv.axes.enabled')} navFirst={first} focusKey={`axis:${id}:enabled`} value={s.enabled} onChange={(enabled) => set({ enabled })} />
      <TvRow kind="switch" label={t('tv.axes.invert')} value={s.invert} onChange={(invert) => set({ invert })} disabled={!s.enabled} />
      <TvRow kind="number" label={t('tv.axes.rangeFrom')} value={Math.round(s.min * 100)} min={0} max={Math.round(s.max * 100)} step={5} format={(v) => `${v}%`} onChange={(v) => set({ min: v / 100 })} disabled={!s.enabled} />
      <TvRow kind="number" label={t('tv.axes.rangeTo')} value={Math.round(s.max * 100)} min={Math.round(s.min * 100)} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ max: v / 100 })} disabled={!s.enabled} />
      <TvRow kind="number" label={t('tv.quickSettings.intensity')} value={Math.round(s.amplitude * 100)} min={0} max={200} step={5} format={(v) => pct(v / 100)} onChange={(v) => set({ amplitude: v / 100 })} disabled={!s.enabled} />
    </>
  )
}

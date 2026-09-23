import type { MessageKey } from '@shared/i18n'
import { EFFECT_RANGE, type EffectOverride } from '@shared/tracking'
import { Select } from '@/components/ui/Select'
import { Stepper } from '@/components/ui/Stepper'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

const multiplier = (v: number) => `${Number(v.toFixed(2))}×`
const CHOICE: ReadonlyArray<{ value: 'unchanged' | 'set'; label: MessageKey }> = [{ value: 'unchanged', label: 'tracking.override.unchanged' }, { value: 'set', label: 'tracking.override.set' }]

interface Props {
  value: EffectOverride
  name: string
  onChange: (patch: Partial<EffectOverride>) => void
}

export function OverrideFields({ value, name, onChange }: Props) {
  const t = useT()
  const estimMax = useSettings((s) => s.settings?.estim.volumeMax ?? 1)
  const r = EFFECT_RANGE
  const choice = CHOICE.map((o) => ({ value: o.value, label: t(o.label) }))
  return (
    <>
      <div className="adv-field">
        <span>{t('tracking.override.tempo')}</span>
        <Stepper value={value.tempo} min={r.tempo[0]} max={r.tempo[1]} step={0.25} format={multiplier} label={t('tracking.override.tempoLabel', { name })} onChange={(tempo) => onChange({ tempo })} />
      </div>
      <div className="adv-field">
        <span>{t('tracking.intensity')}</span>
        <Stepper value={Math.round(value.intensity * 100)} max={r.intensity[1] * 100} label={t('tracking.override.intensityLabel', { name })} onChange={(v) => onChange({ intensity: v / 100 })} />
      </div>
      <div className="adv-field">
        <span>{t('tracking.override.playbackSpeed')}</span>
        <Stepper value={value.playbackSpeed} min={r.playbackSpeed[0]} max={r.playbackSpeed[1]} step={0.25} format={multiplier} label={t('tracking.override.playbackSpeedLabel', { name })} onChange={(playbackSpeed) => onChange({ playbackSpeed })} />
      </div>
      <div className="adv-field">
        <span>{t('tracking.override.strokeSpeed')}</span>
        <Select label={t('tracking.override.strokeSpeedOverrideLabel', { name })} value={value.strokeSpeed == null ? 'unchanged' : 'set'} options={[choice[0]!, { value: 'set', label: t('tracking.override.limit') }]} onChange={(v) => onChange({ strokeSpeed: v === 'unchanged' ? null : 1 })} />
      </div>
      {value.strokeSpeed != null && (
        <div className="adv-field">
          <span>{t('tracking.override.travelPerSecond')}</span>
          <Stepper value={Math.round(value.strokeSpeed * 100)} min={r.strokeSpeed[0] * 100} max={r.strokeSpeed[1] * 100} step={25} format={(v) => `${v}%/s`} label={t('tracking.override.strokeSpeedLabel', { name })} onChange={(v) => onChange({ strokeSpeed: v / 100 })} />
        </div>
      )}
      <div className="adv-field">
        <span>{t('tracking.override.estimMax')}</span>
        <Select className="estim-override-select" label={t('tracking.override.estimOverrideLabel', { name })} value={value.estimMaxRelative != null ? 'relative' : value.estimMax === null ? 'unchanged' : 'set'} options={[...choice, { value: 'relative', label: t('tracking.override.setRelative') }]} onChange={(v) => onChange({ estimMax: v === 'set' ? estimMax : null, estimMaxRelative: v === 'relative' ? 1 : null })} />
      </div>
      {value.estimMaxRelative != null && (
        <div className="adv-field">
          <span>{t('tracking.override.relativeMax')}</span>
          <Stepper value={Math.round(value.estimMaxRelative * 100)} max={200} format={(v) => `${v}%`} label={t('tracking.override.relativeEstimMaxLabel', { name })} onChange={(v) => onChange({ estimMaxRelative: v / 100 })} />
        </div>
      )}
      {value.estimMax !== null && (
        <div className="adv-field">
          <span>{t('tracking.override.maximum')}</span>
          <Stepper value={Math.round(value.estimMax * 100)} max={100} label={t('tracking.override.estimMaxLabel', { name })} onChange={(v) => onChange({ estimMax: v / 100 })} />
        </div>
      )}
      <div className="adv-field">
        <span>{t('tracking.override.vibrateMax')}</span>
        <Select label={t('tracking.override.vibrateOverrideLabel', { name })} value={value.vibeMax == null ? 'unchanged' : 'set'} options={choice} onChange={(v) => onChange({ vibeMax: v === 'unchanged' ? null : 1 })} />
      </div>
      {value.vibeMax != null && (
        <div className="adv-field">
          <span>{t('tracking.override.maximum')}</span>
          <Stepper value={Math.round(value.vibeMax * 100)} max={100} label={t('tracking.override.vibrateMaxLabel', { name })} onChange={(v) => onChange({ vibeMax: v / 100 })} />
        </div>
      )}
    </>
  )
}

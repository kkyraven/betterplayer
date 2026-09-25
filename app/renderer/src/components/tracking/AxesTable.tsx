import { useMemo } from 'react'
import { AXIS_NAME } from '@shared/axes'
import { BEAT_SPEEDS, BROWSER_STROKE_SOURCES, DEFAULT_MODELS, INTENSITY_MAX, PLAYER_ONLY_SOURCES, SMOOTHING_MAX_MS, TRACK_AXES, TRACK_SOURCES, TRACK_SOURCE_LABEL, beatSpeed, entitledMusicModel, isSupporterModel, type ModelKind, type TrackAxesConfig, type TrackAxisConfig, type TrackAxisId, type TrackSource } from '@shared/tracking'
import { models } from '@/engine/client'
import { isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useTracking } from '@/state/tracking'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Stepper } from '@/components/ui/Stepper'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import './AxesTable.css'

const SOURCE_MODEL: Partial<Record<TrackSource, ModelKind>> = { 'ai-motion': 'motion', 'ai-music': 'music' }
let cachedMusicModels: { id: string; label: string }[] | null = null
function shippedMusicModels(): { id: string; label: string }[] {
  return (cachedMusicModels ??= models()
    .filter((m) => m.kind === 'music')
    .map((m) => ({ id: m.id, label: m.label })))
}
const percent = (v: number) => `${v}%`

interface Props {
  axes: TrackAxesConfig
  onChange: (id: TrackAxisId, patch: Partial<TrackAxisConfig>) => void
  scripted?: ReadonlySet<string>
  beat?: boolean
  present?: Partial<Record<ModelKind, boolean>>
  faptap?: 'ready' | 'off'
}

export function AxesTable({ axes, onChange, scripted, beat = true, present, faptap }: Props) {
  const t = useT()
  const premium = useAccount(isPremium)
  const chosenMusic = useSettings((s) => s.settings?.tracking.models.music ?? DEFAULT_MODELS.music)
  const update = useSettings((s) => s.update)
  const refreshModels = useTracking((s) => s.refreshModels)
  const millis = (v: number) => (v === 0 ? t('common.off') : t('common.millisShort', { value: v }))
  const musicModels = useMemo(() => shippedMusicModels().map((m) => ({ ...m, locked: isSupporterModel(m.id) && !premium })), [premium])
  const entitled = entitledMusicModel(chosenMusic, premium)
  const playing = musicModels.find((m) => m.id === entitled)?.id ?? musicModels[0]?.id ?? null
  const chooseMusic = async (id: string) => {
    if (id === chosenMusic) return
    await update((s) => ({ ...s, tracking: { ...s.tracking, models: { ...s.tracking.models, music: id } } }))
    await refreshModels()
  }
  const pick = (id: TrackAxisId, value: string) => {
    const [source, model] = value.split('#') as [TrackSource, string | undefined]
    if (model) void chooseMusic(model)
    onChange(id, { source })
  }
  const options = (stroke: boolean, funscript: boolean) =>
    TRACK_SOURCES.filter((value) => (beat || !PLAYER_ONLY_SOURCES.includes(value)) && ((stroke && faptap !== undefined) || !BROWSER_STROKE_SOURCES.includes(value))).flatMap((value) => {
      const model = SOURCE_MODEL[value]
      const missing = model !== undefined && present !== undefined && !present[model]
      const off = value === 'faptap' && faptap === 'off'
      const title = missing ? t('tracking.noModel') : off ? t('tracking.axesTable.intifacePath') : undefined
      if (value === 'ai-music' && musicModels.length > 1) {
        return musicModels.map((m) => ({
          value: `${value}#${m.id}`,
          label: t(m.locked ? 'tracking.axesTable.musicOptionSupporter' : 'tracking.axesTable.musicOption', { source: t(TRACK_SOURCE_LABEL[value]), model: m.label }),
          disabled: missing || m.locked,
          title: m.locked ? t('tracking.supporterOnly') : title,
        }))
      }
      return [{ value: value as string, label: value === 'off' && funscript ? t('tracking.axesTable.funscript') : t(TRACK_SOURCE_LABEL[value]), disabled: missing || off, title }]
    })
  const valueOf = (source: TrackSource) => (source === 'ai-music' && musicModels.length > 1 && playing ? `${source}#${playing}` : source)
  const spreadable = !BROWSER_STROKE_SOURCES.includes(axes.L0.source)
  const applyAll = () => {
    for (const { id } of TRACK_AXES) if (id !== 'L0') onChange(id, { source: axes.L0.source })
  }
  return (
    <div className="axes-table">
      <div className="axrow head">
        <span />
        <span>{t('tracking.axis')}</span>
        <span className="srchead">
          {t('tracking.axesTable.source')}
          {spreadable && (
            <button type="button" className="all" onClick={applyAll} title={t('tracking.axesTable.putEveryAxis', { source: t(TRACK_SOURCE_LABEL[axes.L0.source]) })}>
              {t('tracking.axesTable.allFrom', { axis: 'L0' })}
            </button>
          )}
        </span>
        <span>{t('tracking.axesTable.limits')}</span>
        <span>{t('tracking.intensity')}</span>
        <span>{t('tracking.axesTable.smoothing')}</span>
        <span>{t('tracking.invert')}</span>
      </div>
      {TRACK_AXES.map(({ id, component }) => {
        const row = axes[id]
        const off = row.source === 'off'
        const name = t(AXIS_NAME[id])
        return (
          <div key={id} className={cx('axrow', off && 'off')}>
            <span className="axis">{id}</span>
            <span className="name">
              {name}
              <span className="comp">{off ? '' : component}</span>
            </span>
            <Select options={options(id === 'L0', scripted?.has(id) ?? false)} value={valueOf(row.source)} onChange={(v) => pick(id, v)} label={t('tracking.axesTable.sourceLabel', { name })} />
            <div className={cx('sl', off && 'dim')} data-label={t('tracking.axesTable.limits')}>
              <Slider
                value={[Math.round(row.min * 100), Math.round(row.max * 100)]}
                step={5}
                label={t('tracking.axesTable.limitLabel', { name })}
                thumbTitle={percent}
                onValueChange={([min, max]) => onChange(id, { min: (min ?? 0) / 100, max: (max ?? 100) / 100 })}
              />
            </div>
            {id === 'R0' && row.source === 'beat' ? (
              <Stepper data-label={t('tracking.intensity')} value={BEAT_SPEEDS.indexOf(beatSpeed(row.intensity))} max={2} step={1} format={(v) => ['½×', '1×', '2×'][v] ?? '1×'} label={t('devices.output.axisSpeed', { axis: name })} onChange={(v) => onChange(id, { intensity: BEAT_SPEEDS[v] ?? 1 })} />
            ) : (
              <Stepper data-label={t('tracking.intensity')} value={Math.round(row.intensity * 100)} max={INTENSITY_MAX * 100} label={t('tracking.axesTable.intensityLabel', { name })} onChange={(v) => onChange(id, { intensity: v / 100 })} />
            )}
            <Stepper data-label={t('tracking.axesTable.smoothing')} value={Math.round(row.smoothingMs)} max={SMOOTHING_MAX_MS} step={10} format={millis} label={t('tracking.axesTable.smoothingLabel', { name })} onChange={(smoothingMs) => onChange(id, { smoothingMs })} />
            <Switch data-label={t('tracking.invert')} checked={row.invert} onCheckedChange={(invert) => onChange(id, { invert })} label={t('tracking.axesTable.invertLabel', { name })} />
          </div>
        )
      })}
    </div>
  )
}

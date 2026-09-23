import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react'
import type { OutputState } from 'bp-engine'
import { useEffect, useState } from 'react'
import { AXIS_NAME } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import { PARAM_AXES, defaultAxisSettings, defaultParamSource, defaultRamp, type ParamAxisId, type ParamSourceKind, type ParamSourceSettings, type RampSettings } from '@shared/settings'
import { DetectionFields } from '@/components/estim/DetectionFields'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { OptionStepper } from '@/components/ui/OptionStepper'
import { Switch } from '@/components/ui/Switch'
import { engine } from '@/engine/client'
import { cx } from '@/lib/cx'
import { setAxisDefault } from '@/state/axisDefaults'
import { setEstim } from '@/state/estim'
import { useDevices, usePlayerAxes, type ConfiguredOutput } from '@/state/devices'
import { t, useT } from '@/state/i18n'
import { usePlayer, useScriptedAxes } from '@/state/player'
import { useSettings } from '@/state/settings'

const SOURCE_OPTIONS: ReadonlyArray<{ value: ParamSourceKind; label: MessageKey }> = [
  { value: 'restim', label: 'devices.restim.source.restim' },
  { value: 'fixed', label: 'devices.restim.source.fixed' },
  { value: 'sweep', label: 'devices.restim.source.sweep' },
  { value: 'audio', label: 'devices.restim.source.audio' },
  { value: 'detection', label: 'devices.restim.source.detection' },
]
const SWEEP_OPTIONS = [
  { value: 'sine', label: 'devices.restim.sweep.sine' },
  { value: 'random', label: 'devices.restim.sweep.random' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey }>
const options = <V extends string>(o: ReadonlyArray<{ value: V; label: MessageKey }>) => o.map((x) => ({ value: x.value, label: t(x.label) }))
const MAIN: readonly ParamAxisId[] = ['C0', 'P0']
const ADVANCED: readonly ParamAxisId[] = ['P1', 'P2', 'P3']
const RESPONSES = [0, 0.25, 0.5, 1, 1.5, 2] as const
const SWEEP_SECONDS = [1, 2, 4, 8, 15, 30, 60] as const
const RAMP_STARTS = [0, 10, 20, 30, 40, 50, 60, 70, 75, 80, 90, 100] as const
const RAMP_MINUTES = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120] as const

const pct = (v: number) => `${Math.round(v * 100)}%`
const secs = (s: number) => (s >= 60 ? t('devices.minutes', { value: s / 60 }) : t('devices.seconds', { value: s }))

function useSourceHints(): { audio: string | null; detection: string | null } {
  const path = usePlayer((s) => s.path)
  const [hints, setHints] = useState<{ audio: string | null; detection: string | null }>({ audio: null, detection: null })
  useEffect(() => {
    const read = () => {
      const beat = engine.beatState()
      const detector = engine.trackState().detector
      setHints({
        audio: !path ? t('devices.restim.hint.needsVideo') : beat.status === 'analysing' ? t('devices.restim.hint.analysing') : beat.status === 'error' && beat.error !== undefined && !beat.error.includes('no beats') ? beat.error : null,
        detection: detector.status === 'none' ? t('devices.restim.hint.needsModel') : detector.status === 'loading' ? t('devices.restim.hint.loadingModel') : detector.status === 'error' ? (detector.error ?? t('devices.restim.hint.modelFailed')) : null,
      })
    }
    read()
    const timer = window.setInterval(read, 1000)
    return () => window.clearInterval(timer)
  }, [path])
  return hints
}

export function RestimPanel({ output, state }: { output: ConfiguredOutput; state: OutputState | undefined }) {
  const t = useT()
  const [advanced, setAdvanced] = useState(false)
  const params = useSettings((s) => s.settings?.estim.params) ?? false
  return (
    <>
      <div className="section">
        <span className="eyebrow">
          {t('devices.restim.sessionRamp')}<a className="eyebrow-note">{t('devices.restim.shareOfLimits')}</a>
        </span>
        <RampCard output={output} progress={state?.ramp} />
      </div>
      <div className="section">
        <span className="eyebrow">
          {t('devices.restim.parameters')}<a className="eyebrow-note">{t('devices.restim.shareOfLimits')}</a>
        </span>
        {params ? (
          <div className="rcards">
            {MAIN.map((id) => (
              <ParamCard key={id} output={output} id={id} />
            ))}
            <button type="button" className="disclose" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown /> : <ChevronRight />}
              {t('devices.restim.advanced')}
              <span className="faint">{t('devices.restim.advancedSub')}</span>
            </button>
            {advanced && (
              <div className="disclosure-content">
                {ADVANCED.map((id) => (
                  <ParamCard key={id} output={output} id={id} />
                ))}
                <ResponseRow />
              </div>
            )}
          </div>
        ) : (
          <div className="rcard rrow response">
            <span className="k">{t('devices.restim.frequencies')}</span>
            <span className="faint">{t('devices.restim.offInSettings')}</span>
            <span className="spacer" />
            <Button onClick={() => setEstim({ params: true }, true)}>{t('devices.restim.turnOn')}</Button>
          </div>
        )}
      </div>
    </>
  )
}

function RampCard({ output, progress }: { output: ConfiguredOutput; progress: OutputState['ramp'] }) {
  const t = useT()
  const setRamp = useDevices((s) => s.setRamp)
  const restart = useDevices((s) => s.restartRamp)
  const ramp = output.config.ramp ?? defaultRamp()
  const patch = (p: Partial<RampSettings>) => void setRamp(output.id, { ...ramp, ...p })
  const left = progress ? Math.ceil(Math.max(0, progress.durationMs - progress.elapsedMs) / 60_000) : 0
  return (
    <div className={cx('rcard', ramp.enabled && 'on')}>
      <div className="rtop">
        <span className="rname">{t('devices.restim.rampVolume')}</span>
        <span className="spacer" />
        <Switch label={t('devices.restim.rampVolume')} checked={ramp.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
      </div>
      {progress && (
        <div className="rprog">
          <div className="rampbar" aria-hidden>
            <i style={{ left: `${progress.start * 100}%`, width: `${Math.max(0, progress.value - progress.start) * 100}%` }} />
            <b style={{ left: `${progress.value * 100}%` }} />
          </div>
          <span className="val mono">{left > 0 ? t('devices.restim.rampProgress', { value: pct(progress.value), max: pct(progress.max), minutes: left }) : t('devices.restim.rampHolding', { value: pct(progress.value) })}</span>
          <Button onClick={() => restart(output.id)}>
            <RotateCw />
            {t('devices.restim.restart')}
          </Button>
        </div>
      )}
      <div className="rvals">
        <span className="f">
          {t('devices.restim.rampStart')}
          <OptionStepper label={t('devices.restim.rampStart')} value={ramp.start * 100} options={RAMP_STARTS} format={(v) => `${v}%`} onChange={(v) => patch({ start: v / 100, max: Math.max(ramp.max, v / 100) })} />
        </span>
        <span className="f">
          {t('devices.restim.rampUpTo')}
          <OptionStepper label={t('devices.restim.rampUpTo')} value={ramp.max * 100} options={RAMP_STARTS} format={(v) => `${v}%`} onChange={(v) => patch({ max: v / 100, start: Math.min(ramp.start, v / 100) })} />
        </span>
        <span className="f">
          {t('devices.restim.rampOver')}
          <OptionStepper label={t('devices.restim.rampOver')} value={ramp.minutes} options={RAMP_MINUTES} format={(v) => t('devices.minutes', { value: v })} onChange={(minutes) => patch({ minutes })} />
        </span>
      </div>
    </div>
  )
}

function ParamCard({ output, id }: { output: ConfiguredOutput; id: ParamAxisId }) {
  const t = useT()
  const setParam = useDevices((s) => s.setParam)
  const axis = useSettings((s) => s.settings?.axesDefault[id]) ?? defaultAxisSettings(id)
  const overridden = usePlayer((s) => s.video.axes[id] !== undefined)
  const sourceOverridden = usePlayer((s) => s.video.params?.[id] !== undefined)
  const scripted = useScriptedAxes().includes(id)
  const live = usePlayerAxes()[id]
  const param = output.config.params?.[id] ?? defaultParamSource()
  const patch = (p: Partial<ParamSourceSettings>) => void setParam(output.id, id, { ...param, ...p })
  const off = param.source === 'restim'
  const sweepSeconds = param.provider === 'sine' ? param.providerPeriodMs / 1000 : 1 / param.providerSpeed
  const hints = useSourceHints()
  const hint = param.source === 'audio' ? hints.audio : param.source === 'detection' ? hints.detection : null
  const feeding = !off && hint === null
  return (
    <div className={cx('rcard', !off && 'on')}>
      <div className="rtop">
        <span className="axis">{id}</span>
        <span className="rname">{t(AXIS_NAME[id])}</span>
        {feeding && live !== undefined && <span className="rlive mono">{pct(live)}</span>}
        {sourceOverridden && <span className="faint">{t('devices.restim.sourceOverridden')}</span>}
        <span className="spacer" />
        {param.source === 'sweep' && (
          <>
            <Segmented label={t('devices.restim.sweepLabel', { axis: t(AXIS_NAME[id]) })} options={options(SWEEP_OPTIONS)} value={param.provider} onChange={(provider) => patch({ provider })} />
            <OptionStepper
              label={t('devices.restim.sweepTimeLabel', { axis: t(AXIS_NAME[id]) })}
              value={sweepSeconds}
              options={SWEEP_SECONDS}
              format={secs}
              onChange={(s) => patch(param.provider === 'sine' ? { providerPeriodMs: s * 1000 } : { providerSpeed: 1 / s })}
            />
          </>
        )}
        <Segmented label={t('devices.restim.sourceLabel', { axis: t(AXIS_NAME[id]) })} options={options(SOURCE_OPTIONS)} value={param.source} onChange={(source) => patch({ source })} />
      </div>
      {scripted && <span className="faint">{t('devices.restim.scripted', { axis: t(AXIS_NAME[id]).toLowerCase() })}</span>}
      {!off && !scripted && (
        <>
          {param.source === 'detection' && <DetectionFields id={id} param={param} onChange={patch} />}
          {hint && <span className="rhint">{hint}</span>}
          {param.source === 'fixed' && (
            <div className="rrow">
              <span className="k">{t('devices.restim.value')}</span>
              <Slider label={t('devices.restim.valueLabel', { axis: t(AXIS_NAME[id]) })} value={[Math.round(param.value * 100)]} onValueChange={([v]) => v !== undefined && patch({ value: v / 100 })} />
              <span className="val mono">{pct(param.value)}</span>
            </div>
          )}
          <div className="rrow">
            <span className="k">{t('devices.restim.range')}</span>
            <div className="track-wrap">
              {feeding && live !== undefined && <em className="live" style={{ left: `${live * 100}%` }} />}
              <Slider
                label={t('devices.restim.rangeLabel', { axis: t(AXIS_NAME[id]) })}
                value={[Math.round(axis.min * 100), Math.round(axis.max * 100)]}
                onValueChange={([min, max]) => {
                  if (min !== undefined && max !== undefined) setAxisDefault(id, { min: min / 100, max: max / 100 })
                }}
              />
            </div>
            <span className="val mono">
              {t('devices.restim.rangeValue', { min: Math.round(axis.min * 100), max: Math.round(axis.max * 100) })}
            </span>
          </div>
          <div className="rfoot">
            <span className="opt">
              <Switch label={t('devices.restim.invertLabel', { axis: t(AXIS_NAME[id]) })} checked={axis.invert} onCheckedChange={(invert) => setAxisDefault(id, { invert }, true)} />
              {t('devices.restim.invert')}
            </span>
            {overridden && <span className="faint">{t('devices.restim.rangeOverridden')}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function ResponseRow() {
  const t = useT()
  const limit = useSettings((s) => s.settings?.axesDefault.C0.speedLimit) ?? 0
  const seconds = limit > 0 ? 1 / limit : 0
  const apply = (s: number) => {
    for (const id of PARAM_AXES) setAxisDefault(id, { speedLimit: s > 0 ? 1 / s : 0 }, true)
  }
  return (
    <div className="rcard rrow response">
      <span className="k">{t('devices.restim.response')}</span>
      <span className="faint">{t('devices.restim.responseSub')}</span>
      <span className="spacer" />
      <OptionStepper label={t('devices.restim.response')} value={seconds} options={RESPONSES} format={(v) => (v === 0 ? t('devices.restim.atOnce') : t('devices.seconds', { value: v }))} onChange={apply} />
    </div>
  )
}

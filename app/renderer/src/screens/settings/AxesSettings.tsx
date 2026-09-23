import { useState } from 'react'
import { Prompt } from '@/components/ui/Prompt'
import { settingTarget } from './navigation'
import { SettingsAdvanced } from './SettingsSection'
import { AXES, AXIS_LABEL, AXIS_IDS, AXIS_NAME, axisRecord, type AxisId } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import { ESTIM_BOOST_AXES, defaultAxisSettings, defaultEstim, type AxisSettings, type EstimVolumeBoost, type Interpolation, type Provider } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Select } from '@/components/ui/Select'
import { Stepper } from '@/components/ui/Stepper'
import { Switch } from '@/components/ui/Switch'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { pushAxisToEngine, setAxisDefault } from '@/state/axisDefaults'
import { setEstim } from '@/state/estim'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

const PROVIDER_OPTIONS: ReadonlyArray<{ value: Provider; label: MessageKey }> = [
  { value: 'none', label: 'common.none' },
  { value: 'random', label: 'settings.axes.provider.random' },
  { value: 'sine', label: 'settings.axes.provider.sine' },
]

const CURVE_OPTIONS: ReadonlyArray<{ value: Interpolation; label: MessageKey }> = [
  { value: 'step', label: 'settings.axes.curve.step' },
  { value: 'linear', label: 'settings.axes.curve.linear' },
  { value: 'pchip', label: 'settings.axes.curve.pchip' },
]

const TCODE = AXES.filter((a) => a.namespace === 'tcode')
const ESTIM = AXES.filter((a) => a.namespace === 'estim')
const BOOST_AXES = ESTIM_BOOST_AXES.map((id) => ({ value: id, label: AXIS_NAME[id] }))

function resetAll() {
  const defaults = axisRecord((id) => defaultAxisSettings(id))
  void useSettings.getState().update((s) => ({ ...s, axesDefault: defaults }))
  for (const id of AXIS_IDS) pushAxisToEngine(id, defaults[id])
}

function isDefault(id: AxisId, s: AxisSettings): boolean {
  const d = defaultAxisSettings(id)
  const keys = new Set([...Object.keys(s), ...Object.keys(d)] as (keyof AxisSettings)[])
  return [...keys].every((k) => s[k] === d[k])
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export function AxesSettings({ estim = false }: { estim?: boolean }) {
  const t = useT()
  const page = estim ? 'estim' : 'axes'
  const [resetting, setResetting] = useState(false)
  const axes = estim ? ESTIM : TCODE
  return (
    <div className="set-axes">
      <p className="sub">{t('settings.axes.sub')}</p>
      {estim && <EstimSection />}
      {axes.map((a) => (
        <AxisSection key={a.id} id={a.id} name={t(a.name)} page={page} />
      ))}
      {!estim && (
        <div className="set-foot" data-setting="reset-all-axes" tabIndex={-1}>
          <Button variant="ghost" onClick={() => setResetting(true)}>
            {t('settings.axes.resetAll')}
          </Button>
        </div>
      )}
      <Prompt
        open={resetting}
        onOpenChange={setResetting}
        title={t('settings.axes.resetAll')}
        body={AXES.map((a) => `${t(a.name)} ${AXIS_LABEL[a.id]}`).join(', ')}
        confirmLabel={t('common.reset')}
        onConfirm={resetAll}
      />
    </div>
  )
}

function EstimSection() {
  const t = useT()
  const estim = useSettings((st) => st.settings?.estim) ?? defaultEstim()
  const defaults = defaultEstim()
  const boost = estim.volumeBoost
  const patchBoost = (patch: Partial<EstimVolumeBoost>) => setEstim({ volumeBoost: { ...boost, ...patch } }, true)
  const changed =
    estim.contrast !== defaults.contrast ||
    estim.volumeFloor !== defaults.volumeFloor ||
    estim.volumeMax !== defaults.volumeMax ||
    estim.params !== defaults.params ||
    boost.enabled !== defaults.volumeBoost.enabled ||
    boost.axis !== defaults.volumeBoost.axis ||
    boost.amount !== defaults.volumeBoost.amount
  return (
    <div className="axset estim">
      <div className="top">
        <span className="name">{t('settings.estim.name')}</span>
        {changed && (
          <button type="button" className="reset" onClick={() => setEstim(defaults, true)}>
            {t('common.reset')}
          </button>
        )}
      </div>
      <Row k={t('settings.estim.contrast')} v={`${Math.round(estim.contrast * 100)}%`}>
        <Slider value={[Math.round(estim.contrast * 100)]} label={t('settings.estim.contrastLabel')} onValueChange={([v]) => setEstim({ contrast: (v ?? 0) / 100 })} />
      </Row>
      <Row k={t('settings.estim.volumeLimits')} v={t('settings.axes.rangeValue', { min: Math.round(estim.volumeFloor * 100), max: Math.round(estim.volumeMax * 100) })}>
        <Slider
          value={[Math.round(estim.volumeFloor * 100), Math.round(estim.volumeMax * 100)]}
          label={t('settings.estim.volumeLimits')}
          onValueChange={([min, max]) => setEstim({ volumeFloor: (min ?? 0) / 100, volumeMax: (max ?? 100) / 100 })}
        />
      </Row>
      <div className="estim-boost" data-setting="volume-boost" tabIndex={-1}>
        <Switch checked={boost.enabled} label={t('settings.estim.volumeBoost')} onCheckedChange={(enabled) => patchBoost({ enabled })} />
        <fieldset disabled={!boost.enabled}>
          <span>{t('settings.estim.boostOn')}</span>
          <Select label={t('settings.estim.boostAxis')} value={boost.axis} options={BOOST_AXES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(axis) => patchBoost({ axis })} />
          <span>{t('settings.estim.by')}</span>
          <Stepper label={t('settings.estim.volumeBoost')} value={Math.round(boost.amount * 100)} max={100} step={1} onChange={(amount) => patchBoost({ amount: amount / 100 })} />
          <span className="faint">{t('settings.estim.pastLimits')}</span>
        </fieldset>
      </div>
      <SettingsAdvanced page="estim" custom={estim.params !== defaults.params}>
        <div className="prow">
          <span className="tog">
            {t('settings.estim.frequencies')} <Switch checked={estim.params} onCheckedChange={(params) => setEstim({ params }, true)} label={t('settings.estim.frequenciesLabel')} />
          </span>
        </div>
      </SettingsAdvanced>
    </div>
  )
}

function AxisSection({ id, name, page }: { id: AxisId; name: string; page: 'axes' | 'estim' }) {
  const t = useT()
  const s = useSettings((st) => st.settings?.axesDefault[id]) ?? defaultAxisSettings(id)
  const defaults = defaultAxisSettings(id)
  const technical = ['extendRange', 'interpolation', 'autoHomeDelayMs', 'autoHomeDurationMs', 'provider', 'providerSpeed', 'providerPeriodMs', 'providerBlend', 'link'] as const
  const custom = technical.some((key) => s[key] !== defaults[key])
  const slide = (patch: Partial<AxisSettings>) => setAxisDefault(id, patch)
  const flip = (patch: Partial<AxisSettings>) => setAxisDefault(id, patch, true)
  const providerOptions = PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))
  const curveOptions = CURVE_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))
  return (
    <div className="axset" data-off={!s.enabled || undefined}>
      <div className="top">
        <span className="axis">{AXIS_LABEL[id]}</span>
        <span className="name">{name}</span>
        {!isDefault(id, s) && (
          <button type="button" className="reset" onClick={() => setAxisDefault(id, defaultAxisSettings(id), true)}>
            {t('common.reset')}
          </button>
        )}
        <span className="tog" data-setting="enabled" tabIndex={-1}>
          {t('common.on')} <Switch checked={s.enabled} onCheckedChange={(enabled) => flip({ enabled })} label={t('settings.axes.enabledLabel', { name })} />
        </span>
        <span className="tog" data-setting="invert" tabIndex={-1}>
          {t('settings.axes.invert')} <Switch checked={s.invert} onCheckedChange={(invert) => flip({ invert })} label={t('settings.axes.invertLabel', { name })} />
        </span>
      </div>
      <Row k={t('settings.axes.range')} v={t('settings.axes.rangeValue', { min: Math.round(s.min * 100), max: Math.round(s.max * 100) })}>
        <Slider
          value={[Math.round(s.min * 100), Math.round(s.max * 100)]}
          label={t('settings.axes.rangeLabel', { name })}
          onValueChange={([min, max]) => slide({ min: (min ?? 0) / 100, max: (max ?? 100) / 100 })}
        />
      </Row>
      <Row k={t('settings.axes.amplitude')} v={`${Math.round(s.amplitude * 100)}%`} hint={t('settings.axes.amplitudeHint')}>
        <Slider value={[Math.round(s.amplitude * 100)]} max={200} label={t('settings.axes.amplitudeLabel', { name })} onValueChange={([v]) => slide({ amplitude: (v ?? 100) / 100 })} />
      </Row>
      <Row k={t('settings.axes.speedLimit')} v={s.speedLimit === 0 ? t('common.off') : t('settings.axes.perSecond', { value: fmtNum(s.speedLimit) })} hint={t('settings.axes.speedLimitHint')}>
        <Slider value={[s.speedLimit]} max={20} step={0.5} label={t('settings.axes.speedLimitLabel', { name })} onValueChange={([v]) => slide({ speedLimit: v ?? 0 })} />
      </Row>
      <SettingsAdvanced page={page} id={id} custom={custom}>
        <Row k={t('settings.axes.rangeExtender')}>
          <Switch checked={s.extendRange} onCheckedChange={(extendRange) => flip({ extendRange })} label={t('settings.axes.rangeExtenderLabel', { name })} />
        </Row>
        <Row k={t('settings.axes.curve')}>
          <Segmented options={curveOptions} value={s.interpolation} onChange={(interpolation) => flip({ interpolation })} label={t('settings.axes.curveLabel', { name })} />
        </Row>
        <Row k={t('settings.axes.autoHomeDelay')} v={s.autoHomeDelayMs === 0 ? t('common.off') : t('common.secondsShort', { value: fmtNum(s.autoHomeDelayMs / 1000) })}>
          <Slider value={[s.autoHomeDelayMs / 1000]} max={30} label={t('settings.axes.autoHomeDelayLabel', { name })} onValueChange={([v]) => slide({ autoHomeDelayMs: (v ?? 0) * 1000 })} />
        </Row>
        <Row k={t('settings.axes.autoHomeTime')} v={t('common.secondsShort', { value: fmtNum(s.autoHomeDurationMs / 1000) })}>
          <Slider
            value={[s.autoHomeDurationMs / 1000]}
            min={0.5}
            max={10}
            step={0.5}
            label={t('settings.axes.autoHomeTimeLabel', { name })}
            onValueChange={([v]) => slide({ autoHomeDurationMs: (v ?? 3) * 1000 })}
          />
        </Row>
        <div data-setting="provider" tabIndex={-1} aria-label={t('settings.axes.motion')}>
          <Row k={t('settings.axes.motion')}>
            <Segmented options={providerOptions} value={s.provider} onChange={(provider) => flip({ provider })} label={t('settings.axes.motionLabel', { name })} />
          </Row>
          <span className="sub">{t('settings.axes.motionCurrent', { provider: providerOptions.find((o) => o.value === s.provider)?.label ?? '' })}</span>
        </div>
        {s.provider === 'random' && (
          <Row k={t('settings.axes.targets')} v={t('settings.axes.perSecond', { value: fmtNum(s.providerSpeed) })}>
            <Slider value={[s.providerSpeed]} min={0.5} max={10} step={0.5} label={t('settings.axes.targetsLabel', { name })} onValueChange={([v]) => slide({ providerSpeed: v ?? 1 })} />
          </Row>
        )}
        {s.provider === 'sine' && (
          <Row k={t('settings.axes.period')} v={t('common.millisShort', { value: s.providerPeriodMs })}>
            <Slider value={[s.providerPeriodMs]} min={200} max={5000} step={100} label={t('settings.axes.periodLabel', { name })} onValueChange={([v]) => slide({ providerPeriodMs: v ?? 1000 })} />
          </Row>
        )}
        {s.provider !== 'none' && (
          <Row k={t('settings.axes.blend')} v={`${Math.round(s.providerBlend * 100)}%`}>
            <Slider value={[Math.round(s.providerBlend * 100)]} label={t('settings.axes.blendLabel', { name })} onValueChange={([v]) => slide({ providerBlend: (v ?? 0) / 100 })} />
          </Row>
        )}
      </SettingsAdvanced>
    </div>
  )
}

function Row({ k, v, hint, children }: { k: string; v?: string; hint?: string; children: React.ReactNode }) {
  const Container = hint ? TooltipGroup : 'div'
  return (
    <Container className="rng" data-setting={settingTarget(k)} data-tooltip={hint} tabIndex={-1}>
      <span className="k">{k}</span>
      <div className="track-wrap">{children}</div>
      <span className="v">{v}</span>
    </Container>
  )
}

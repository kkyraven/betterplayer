import { AXES, AXIS_LABEL, isAxisId } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import { defaultOpenShockTrigger, type OpenShockControl, type OpenShockTrigger } from '@shared/settings'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { useDevices, usePlayerAxes, type ConfiguredOutput } from '@/state/devices'
import { useT } from '@/state/i18n'

const CONTROL_OPTIONS: ReadonlyArray<{ value: OpenShockControl; label: MessageKey }> = [
  { value: 'vibrate', label: 'devices.feature.vibrate' },
  { value: 'shock', label: 'devices.openshock.shock' },
  { value: 'sound', label: 'devices.openshock.sound' },
]
type Side = 'above' | 'below'
const SIDE_OPTIONS: ReadonlyArray<{ value: Side; label: MessageKey }> = [
  { value: 'above', label: 'devices.openshock.above' },
  { value: 'below', label: 'devices.openshock.below' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export function OpenShockPanel({ output }: { output: ConfiguredOutput }) {
  const t = useT()
  const setTrigger = useDevices((s) => s.setTrigger)
  const trigger = output.config.trigger ?? defaultOpenShockTrigger()
  const patch = (p: Partial<OpenShockTrigger>) => void setTrigger(output.id, { ...trigger, ...p })
  const live = usePlayerAxes()[trigger.axis]
  const options = <V extends string>(o: ReadonlyArray<{ value: V; label: MessageKey }>) => o.map((x) => ({ value: x.value, label: t(x.label) }))
  return (
    <div className="section">
      <span className="eyebrow">{t('devices.openshock.trigger')}</span>
      <div className="rcard on">
        <div className="rtop">
          <select
            className="input axis-pick"
            value={trigger.axis}
            aria-label={t('devices.openshock.axis')}
            onChange={(e) => {
              if (isAxisId(e.target.value)) patch({ axis: e.target.value })
            }}
          >
            {AXES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === 'S0' ? '.shock.funscript' : `${AXIS_LABEL[a.id]} ${t(a.name)}`}
              </option>
            ))}
          </select>
          <Segmented label={t('devices.openshock.side')} options={options(SIDE_OPTIONS)} value={trigger.above ? 'above' : 'below'} onChange={(side) => patch({ above: side === 'above' })} />
          {live !== undefined && <span className="rlive mono">{pct(live)}</span>}
          <span className="spacer" />
          <Segmented label={t('devices.openshock.action')} options={options(CONTROL_OPTIONS)} value={trigger.control} onChange={(control) => patch(control === 'shock' ? { control, intensity: 0 } : { control })} />
        </div>
        <p className="shock-hint">{t('devices.shock.scriptHint')}</p>
        <div className="rrow">
          <span className="k">{t('devices.openshock.line')}</span>
          <div className="track-wrap">
            {live !== undefined && <em className="live" style={{ left: `${live * 100}%` }} />}
            <Slider label={t('devices.openshock.line')} value={[Math.round(trigger.line * 100)]} onValueChange={([v]) => v !== undefined && patch({ line: v / 100 })} />
          </div>
          <span className="val mono">{pct(trigger.line)}</span>
        </div>
        <div className="rrow">
          <span className="k">{t('devices.openshock.intensity')}</span>
          <Slider label={t('devices.openshock.intensity')} value={[trigger.intensity]} onValueChange={([v]) => v !== undefined && patch({ intensity: v })} />
          <span className="val mono">{trigger.intensity === 0 ? t('common.off') : `${trigger.intensity}%`}</span>
        </div>
      </div>
    </div>
  )
}

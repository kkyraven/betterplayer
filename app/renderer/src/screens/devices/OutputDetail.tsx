import { Trash2 } from 'lucide-react'
import type { AxisClamp, OutputState } from 'bp-engine'
import { useState } from 'react'
import { AXES, AXIS_LABEL, AXIS_NAME, TCODE_AXES, axesForProfile, isAxisId, type AxisId } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import { OUTPUT_DELAY_MAX, OUTPUT_PROFILES, VIBRATION_DEPTH_MAX, VIBRATION_SOURCES, defaultFeatureLevel, defaultVibration, featureLevelOutput, vibrationHzMax, type FeatureLevel, type OutputProfile } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { engine } from '@/engine/client'
import { cx } from '@/lib/cx'
import { outputName, setStopOnPause, useDevices, useOutputStats, usePlayerAxes, type ConfiguredOutput } from '@/state/devices'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { isPremium, useAccount } from '@/state/account'
import { OpenShockPanel } from './OpenShockPanel'
import { RestimPanel } from './RestimPanel'
import { featureName, ossmText, statusDot, statusText } from './status'

const SAFETY: ReadonlyArray<[MessageKey, string]> = [
  ['devices.output.syncRamp', '4 s'],
  ['devices.output.connectGlide', '1.5 s'],
  ['devices.output.speedLimit', '10/s'],
  ['devices.output.autoHome', '5 s'],
]

const PROFILE_OPTIONS: ReadonlyArray<{ value: OutputProfile; label: MessageKey }> = OUTPUT_PROFILES.map((p) => ({ value: p, label: p === 'stroker' ? 'devices.output.stroker' : 'devices.output.restim' }))

export function OutputDetail({ output, state }: { output: ConfiguredOutput; state: OutputState | undefined }) {
  const t = useT()
  const remove = useDevices((s) => s.remove)
  const setProfile = useDevices((s) => s.setProfile)
  const rename = useDevices((s) => s.rename)
  const setStrength = useDevices((s) => s.setStrength)
  const setFeatureAxis = useDevices((s) => s.setFeatureAxis)
  const setFeatureLevel = useDevices((s) => s.setFeatureLevel)
  const setVibration = useDevices((s) => s.setVibration)
  const setDelay = useDevices((s) => s.setDelay)
  const stopOnPause = useSettings((s) => s.settings?.devices.stopOnPause ?? true)
  const [clamps, setClamps] = useState<AxisClamp[]>(() => engine.outputClamps(output.id) ?? AXES.map(() => ({ enabled: true, min: 0, max: 1 })))
  const [name, setName] = useState(output.config.name ?? '')
  const live = usePlayerAxes()
  const stats = useOutputStats(output.id)
  const profile = output.config.profile
  const premium = useAccount(isPremium)
  const kind = output.config.kind
  const supporterLocked = kind === 'pishock' && !premium
  const isOssm = kind === 'ossm'
  const axes = axesForProfile(profile).filter((a) => a.kind !== 'estimParam' && (!isOssm || a.id === 'L0'))
  const isSocket = kind === 'websocket' || kind === 'tcp' || kind === 'udp'
  const isToy = kind === 'toy'
  const shakes = profile === 'stroker' && (isSocket || kind === 'serial' || kind === 'ble' || isOssm)
  const vibration = output.config.vibration
  const hzMax = vibrationHzMax(kind)
  const isHowl = output.config.kind === 'howl'
  const isOpenShock = output.config.kind === 'openshock' || kind === 'pishock'
  const hasDelay = kind !== 'handy' && !isHowl
  const delay = output.config.delayMs ?? 0
  const hasLevels = isToy || kind === 'buttplug' || (profile === 'stroker' && (isSocket || kind === 'serial' || kind === 'ble'))

  const setClamp = (index: number, clamp: AxisClamp) => {
    const axis = AXES[index]
    if (!axis) return
    setClamps((c) => c.map((old, i) => (i === index ? clamp : old)))
    engine.setOutputClamp(output.id, axis.id, clamp)
  }

  const meta = [isToy || isOssm ? 'bluetooth' : kind, state?.address, state?.device, state?.tcode, state?.battery !== undefined && `${state.battery}%`].filter(Boolean).join(' · ')

  const featureRow = (f: OutputState['features'][number]) => {
    const axis: AxisId | null = f.axis !== undefined && isAxisId(f.axis) ? f.axis : null
    const i = axis ? AXES.findIndex((a) => a.id === axis) : -1
    const clamp = i >= 0 ? (clamps[i] ?? { enabled: true, min: 0, max: 1 }) : null
    const lo = clamp ? Math.round(clamp.min * 100) : 0
    const hi = clamp ? Math.round(clamp.max * 100) : 0
    const value = axis ? live[axis] : undefined
    const name = f.description || featureName(f.kind)
    const level: FeatureLevel | null = f.level ? (output.config.featureLevels?.[f.index] ?? defaultFeatureLevel()) : null
    const pct = (v: number) => Math.round(v * 100)
    const setLevel = (patch: Partial<FeatureLevel>) => {
      if (!level) return
      const next = { ...level, ...patch }
      const d = defaultFeatureLevel()
      setFeatureLevel(output.id, f.index, next.from === d.from && next.to === d.to && next.floor === d.floor && next.cap === d.cap ? null : next)
    }
    const out = level && f.input !== undefined ? featureLevelOutput(level, f.input) : undefined
    return (
      <div key={f.index} className={cx('axrow feat', !axis && 'off', level && 'lvl')}>
        <span className="name">
          {name}
          {f.speed && axis && <span className="sub">{t('devices.output.axisSpeed', { axis: AXES[i] ? t(AXES[i].name) : '' })}</span>}
        </span>
        <select className="input axis-pick" value={axis ?? ''} aria-label={t('devices.output.featureAxis', { name })} onChange={(e) => void setFeatureAxis(output.id, f.index, isAxisId(e.target.value) ? e.target.value : null)}>
          <option value="">{t('common.off')}</option>
          {TCODE_AXES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} {t(a.name)}
            </option>
          ))}
        </select>
        {level && clamp ? (
          <div className="levels">
            <div className="track-wrap" title={t('devices.output.inputHint')}>
              {f.input !== undefined && clamp.enabled && <em className="live" style={{ left: `${f.input * 100}%` }} />}
              <Slider
                label={t('devices.output.featureInput', { name })}
                value={[pct(level.from), pct(level.to)]}
                thumbTitle={(v) => `${v}%`}
                onValueChange={([from, to]) => {
                  if (from !== undefined && to !== undefined) setLevel({ from: from / 100, to: to / 100 })
                }}
              />
            </div>
            <div className="track-wrap" title={t('devices.output.outputHint')}>
              {out !== undefined && clamp.enabled && <em className="live" style={{ left: `${out * 100}%` }} />}
              <Slider
                label={t('devices.output.featureOutput', { name })}
                value={[pct(level.floor), pct(level.cap)]}
                thumbTitle={(v) => `${v}%`}
                onValueChange={([floor, cap]) => {
                  if (floor !== undefined && cap !== undefined) setLevel({ floor: floor / 100, cap: cap / 100 })
                }}
              />
            </div>
          </div>
        ) : (
          <div className="track-wrap">
            {clamp && (
              <>
                {value !== undefined && clamp.enabled && <em className="live" style={{ left: `${(clamp.min + value * (clamp.max - clamp.min)) * 100}%` }} />}
                <Slider
                  label={t('devices.output.rangeLabel', { name })}
                  value={[lo, hi]}
                  onValueChange={([min, max]) => {
                    if (min !== undefined && max !== undefined) setClamp(i, { ...clamp, min: min / 100, max: max / 100 })
                  }}
                />
              </>
            )}
          </div>
        )}
        {level && clamp ? (
          <span className="val mono lvl-val">
            <span>{t('devices.output.levelIn', { from: pct(level.from), to: pct(level.to) })}</span>
            <span>{t('devices.output.levelOut', { floor: pct(level.floor), cap: pct(level.cap) })}</span>
          </span>
        ) : (
          <span className="val mono">{clamp ? t('devices.output.rangeValue', { min: lo, max: hi }) : ''}</span>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="dhead">
        <div className="dhead-t">
          <div className="dhead-row">
            <h1>{outputName(output.config)}</h1>
            <span className={cx('pill-status', state?.status === 'connected' && 'ok', state?.status === 'error' && 'err')}>
              <span className={`dot ${statusDot(state?.status)}`} />
              {supporterLocked ? t('common.supporterOnly') : statusText(state)}
            </span>
          </div>
          <span className="dhead-sub mono">{meta}</span>
        </div>
        <div className="spacer" />
        <span className="dhead-stat">
          <span className="faint">{t('devices.output.linesSent')}</span>
          <span className="mono">{stats?.linesSent ?? 0}</span>
        </span>
      </div>

      <div className="section">
        <span className="eyebrow">{t('devices.output.output')}</span>
        <div className="panel">
          <div className="prow">
            <span className="lbl">{t('devices.output.name')}</span>
            <span className="spacer" />
            <input className="input name-input" value={name} placeholder={outputName({ ...output.config, name: undefined })} aria-label={t('devices.output.deviceName')} onChange={(e) => setName(e.target.value)} onBlur={() => void rename(output.id, name)} />
          </div>
          {output.config.kind === 'handy' && (
            <div className="prow">
              <span className="lbl">{t('devices.wizard.scriptHosting')}</span>
              <span className="spacer" />
              <span className="val">{output.config.hosting === 'lan' ? t('devices.wizard.hosting.lan') : t('devices.wizard.hosting.cloud')}</span>
            </div>
          )}
          {isSocket && (
            <div className="prow">
              <span>
                <div className="lbl">{t('devices.output.profile')}</div>
                <div className="sub">{profile === 'restim' ? t('devices.output.profileRestim') : t('devices.output.profileStroker')}</div>
              </span>
              <span className="spacer" />
              <Segmented options={PROFILE_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} value={profile} onChange={(p) => void setProfile(output.id, p)} label={t('devices.output.profile')} />
            </div>
          )}
        </div>
      </div>

      {profile === 'restim' && <RestimPanel output={output} state={state} />}

      {isOpenShock && <OpenShockPanel output={output} />}

      {isHowl && (
        <div className="section">
          <span className="eyebrow">Howl</span>
          <div className="panel">
            {state?.howl ? (
              <>
                <div className="prow">
                  <span className="lbl">{t('devices.output.playing')}</span>
                  <span className="spacer" />
                  <span className="val">{state.howl.title ? t(state.howl.playing ? 'devices.output.howlPlaying' : 'devices.output.howlPaused', { title: state.howl.title }) : t('devices.output.nothing')}</span>
                </div>
                <div className="prow">
                  <span className="lbl">{t('devices.output.power')}</span>
                  <span className="spacer" />
                  <span className="val mono">
                    {t('devices.output.howlPower', { a: state.howl.powerA, b: state.howl.powerB })}
                    {state.howl.mute && ` · ${t('devices.output.muted')}`}
                  </span>
                </div>
              </>
            ) : (
              <div className="prow">
                <span className="sub">{statusText(state)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {isOssm && (
        <div className="section">
          <span className="eyebrow">OSSM</span>
          <div className="panel">
            <div className="prow">
              <span className="lbl">{t('devices.output.machine')}</span>
              <span className="spacer" />
              <span className="val">{ossmText(state)}</span>
            </div>
            {state?.ossm && (
              <div className="prow">
                <span className="lbl">{t('devices.output.position')}</span>
                <span className="spacer" />
                <span className="val mono">{t('devices.output.mm', { value: Math.round(state.ossm.positionMm) })}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {output.config.kind === 'coyote' && (
        <div className="section">
          <span className="eyebrow">{t('devices.output.strength')}</span>
          <div className="panel">
            {(['A', 'B'] as const).map((ch) => {
              const a = output.config.strengthA ?? 0
              const b = output.config.strengthB ?? 0
              const value = ch === 'A' ? a : b
              return (
                <div key={ch} className="prow">
                  <span className="lbl">{t('devices.output.channel', { channel: ch })}</span>
                  <div className="track-wrap strength">
                    <Slider label={t('devices.output.channelStrength', { channel: ch })} value={[value]} max={200} onValueChange={([v]) => void setStrength(output.id, ch === 'A' ? (v ?? 0) : a, ch === 'B' ? (v ?? 0) : b)} />
                  </div>
                  <span className="val">{value}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {isToy ? (
        <div className="section">
          <span className="eyebrow">{t('devices.output.features')}</span>
          <div className="axhead feat">
            <span />
            <span>{t('devices.output.axis')}</span>
            <span>{t('devices.output.range')}</span>
            <span />
          </div>
          <div className="panel">
            {state?.features.length ? (
              state.features.map(featureRow)
            ) : (
              <div className="prow">
                <span className="sub">{state?.status === 'connected' ? t('devices.output.noFeatures') : statusText(state)}</span>
              </div>
            )}
          </div>
        </div>
      ) : isHowl || isOpenShock ? null : (
      <div className="section">
        <span className="eyebrow">{t('devices.output.axes')}</span>
        <div className="axhead">
          <span />
          <span />
          <span />
          <span>{t('devices.output.range')}</span>
          <span />
        </div>
        <div className="panel">
          {axes.map((axis) => {
            const i = AXES.indexOf(axis)
            const clamp = clamps[i] ?? { enabled: true, min: 0, max: 1 }
            const lo = Math.round(clamp.min * 100)
            const hi = Math.round(clamp.max * 100)
            const value = live[axis.id]
            return (
              <div key={axis.id} className={cx('axrow', !clamp.enabled && 'off')}>
                <span className="axis">{AXIS_LABEL[axis.id]}</span>
                <span className="name">{t(axis.name)}</span>
                <Switch label={t('devices.output.enabledLabel', { name: t(axis.name) })} checked={clamp.enabled} onCheckedChange={(enabled) => setClamp(i, { ...clamp, enabled })} />
                <div className="track-wrap">
                  {value !== undefined && clamp.enabled && <em className="live" style={{ left: `${(clamp.min + value * (clamp.max - clamp.min)) * 100}%` }} />}
                  <Slider
                    label={t('devices.output.rangeLabel', { name: t(axis.name) })}
                    value={[lo, hi]}
                    disabled={!clamp.enabled}
                    onValueChange={([min, max]) => {
                      if (min !== undefined && max !== undefined) setClamp(i, { ...clamp, min: min / 100, max: max / 100 })
                    }}
                  />
                </div>
                <span className="val mono">
                  {t('devices.output.rangeValue', { min: lo, max: hi })}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      )}

      {shakes && (
        <div className="section">
          <span className="eyebrow">{t('devices.output.vibration')}</span>
          <div className="panel">
            <div className="prow">
              <span>
                <div className="lbl">{t('devices.output.source')}</div>
                <div className="sub">{t('devices.output.vibrationSub')}</div>
              </span>
              <span className="spacer" />
              <select className="input axis-pick" value={vibration?.source ?? ''} aria-label={t('devices.output.vibrationSource')} onChange={(e) => void setVibration(output.id, isAxisId(e.target.value) ? { ...(vibration ?? defaultVibration()), source: e.target.value } : null)}>
                <option value="">{t('common.off')}</option>
                {VIBRATION_SOURCES.map((id) => (
                  <option key={id} value={id}>
                    {id} {t(AXIS_NAME[id])}
                  </option>
                ))}
              </select>
            </div>
            {vibration && (
              <>
                <div className="prow">
                  <span className="lbl">{t('devices.output.depth')}</span>
                  <div className="track-wrap strength">
                    <Slider label={t('devices.output.vibrationDepth')} value={[Math.round(vibration.depth * 100)]} min={1} max={VIBRATION_DEPTH_MAX * 100} onValueChange={([v]) => void setVibration(output.id, { ...vibration, depth: (v ?? 1) / 100 })} />
                  </div>
                  <span className="val">{Math.round(vibration.depth * 100)}%</span>
                </div>
                <div className="prow">
                  <span className="lbl">{t('devices.output.rate')}</span>
                  <div className="track-wrap strength">
                    <Slider label={t('devices.output.vibrationRate')} value={[Math.min(vibration.hz, hzMax)]} min={1} max={hzMax} onValueChange={([v]) => void setVibration(output.id, { ...vibration, hz: v ?? 1 })} />
                  </div>
                  <span className="val">{t('devices.output.hz', { value: Math.min(vibration.hz, hzMax) })}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {hasDelay && (
        <div className="section">
          <span className="eyebrow">{t('devices.output.timing')}</span>
          <div className="panel">
            <div className="prow">
              <span>
                <div className="lbl">{t('devices.output.delay')}</div>
                <div className="sub">{t('devices.output.delaySub')}</div>
              </span>
              <div className="track-wrap strength">
                <Slider label={t('devices.output.delay')} value={[delay]} min={-OUTPUT_DELAY_MAX} max={OUTPUT_DELAY_MAX} step={5} onValueChange={([v]) => setDelay(output.id, v ?? 0)} />
              </div>
              <span className="val">{delay === 0 ? t('devices.output.ms', { value: 0 }) : t(delay < 0 ? 'devices.output.msEarly' : 'devices.output.msLate', { value: Math.abs(delay) })}</span>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <span className="eyebrow">{t('devices.output.safety')}</span>
        <div className="panel">
          {hasLevels && (
            <div className="prow">
              <span>
                <div className="lbl">{t('devices.output.stopOnPause')}</div>
                <div className="sub">{t('devices.output.stopOnPauseSub')}</div>
              </span>
              <span className="spacer" />
              <Switch label={t('devices.output.stopLevelsOnPause')} checked={stopOnPause} onCheckedChange={setStopOnPause} />
            </div>
          )}
          {SAFETY.map(([label, value]) => (
            <div key={label} className="prow">
              <span className="lbl">{t(label)}</span>
              <span className="spacer" />
              <span className="val">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <Button variant="ghost" className="btn-danger" onClick={() => void remove(output.id)}>
        <Trash2 />
        {t('devices.screen.removeDevice')}
      </Button>
    </>
  )
}

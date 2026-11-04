import { useState } from 'react'
import { ITCH_URL, SUBSCRIBE_URL } from '@shared/account'
import { AXIS_LABEL, AXIS_NAME, RULE_AXES, type AxisId } from '@shared/axes'
import { fmtSpan } from '@shared/chaster'
import { detectorId, sizeOf } from '@shared/censor'
import {
  CLOTHING,
  CLOTHING_LABELS,
  DENIAL_ACTIONS,
  DENIAL_ACTION_LABELS,
  DENIAL_HOLD_MAX_MS,
  DENIAL_WHENS,
  DENIAL_WHEN_LABELS,
  DETECT_KINDS,
  CENSOR_LOCK_MINUTES,
  CENSOR_STYLES,
  CENSOR_STYLE_LABELS,
  defaultDenialAxis,
  type DenialAxis,
  type DetectKindId,
} from '@shared/settings'
import { AxisToggles } from '@/components/media/AxisToggles'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { electron } from '@/node'
import { checkSupporter, isFree, useAccount } from '@/state/account'
import { t, useT } from '@/state/i18n'
import { useChaster, useMinuteClock } from '@/state/chaster'
import { useDenial } from '@/state/denial'
import { useCensor } from '@/state/censor'
import { percent, useModels } from '@/state/models'
import { useSettings } from '@/state/settings'
import { ModelSizeRow } from './ModelSizeRow'
import { SettingsLink } from './SettingsSection'
import '@/components/media/AxisChips.css'

const STYLE_OPTIONS = CENSOR_STYLES.map((value) => ({ value, label: CENSOR_STYLE_LABELS[value] }))
const WHEN_OPTIONS = DENIAL_WHENS.map((value) => ({ value, label: DENIAL_WHEN_LABELS[value] }))
const CLOTHING_OPTIONS = CLOTHING.map((value) => ({ value, label: CLOTHING_LABELS[value] }))
const ACTION_OPTIONS = DENIAL_ACTIONS.map((value) => ({ value, label: DENIAL_ACTION_LABELS[value] }))

type LockChoice = 'off' | 'chaster' | `${(typeof CENSOR_LOCK_MINUTES)[number]}`

const minutesLabel = (m: number) => (m < 60 ? t('settings.gooner.minutes', { count: m }) : t('settings.gooner.hours', { count: m / 60 }))

export function CensorSettings() {
  const t = useT()
  const censor = useCensor((s) => s.censor)
  const locked = useCensor((s) => s.locked)
  const set = useCensor((s) => s.set)
  const denial = useDenial((s) => s.denial)
  const setDenial = useDenial((s) => s.set)
  const chasterLock = useChaster((s) => s.status.lock)
  const free = useAccount(isFree)
  const now = useMinuteClock()
  const [choice, setChoice] = useState<LockChoice>('off')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const strength = dragging ?? Math.round(censor.strength * 100)

  const denialOn = denial.enabled
  const installed = useCensor((s) => s.detector === 'installed')
  const anyOn = (censor.enabled || denialOn) && installed
  const purchased = async () => {
    setChecking(true)
    setMessage(await checkSupporter())
    setChecking(false)
  }
  const lock = () => {
    if (choice === 'off') return
    void set({ lock: choice === 'chaster' ? { kind: 'chaster' } : { kind: 'until', endsAt: Date.now() + Number(choice) * 60_000 } })
    setChoice('off')
  }
  const toggleAxes = (next: AxisId[]) => {
    const axes = { ...denial.axes }
    for (const id of RULE_AXES) {
      if (next.includes(id)) axes[id] ??= defaultDenialAxis()
      else delete axes[id]
    }
    void setDenial({ axes })
  }
  const setAxisRule = (id: AxisId, patch: Partial<DenialAxis>) => void setDenial({ axes: { ...denial.axes, [id]: { ...(denial.axes[id] ?? defaultDenialAxis()), ...patch } } })
  const axisRules = RULE_AXES.flatMap((id) => {
    const rule = denial.axes[id]
    return rule ? [[id, rule] as const] : []
  })

  const lockOptions: ReadonlyArray<{ value: LockChoice; label: string; disabled?: boolean; title?: string }> = [
    { value: 'off', label: t('common.off') },
    ...CENSOR_LOCK_MINUTES.map((m) => ({ value: `${m}` as const, label: minutesLabel(m) })),
    { value: 'chaster', label: t('settings.gooner.untilChaster'), disabled: chasterLock === null, title: chasterLock === null ? t('settings.gooner.noChasterLock') : undefined },
  ]
  const lockText =
    censor.lock?.kind === 'until'
      ? t('settings.gooner.timeLeft', { time: fmtSpan(censor.lock.endsAt - now) })
      : chasterLock
        ? t('settings.gooner.chasterLocked', { time: fmtSpan(now - chasterLock.startedAt) })
        : t('settings.gooner.untilChaster')
  const held =
    censor.enabled && denialOn
      ? t('settings.gooner.bothHold', { a: t('settings.gooner.hide'), b: t('settings.gooner.denial') })
      : censor.enabled || denialOn
        ? t('settings.gooner.holds', { tool: t(censor.enabled ? 'settings.gooner.hide' : 'settings.gooner.denial') })
        : null

  return (
    <div className="set-censor">
      {free && (
        <div className="panel">
          <div className="prow">
            <span>
              <div className="lbl">{t('common.supporterOnly')}</div>
              <div className="sub">{message ?? t('vr.offer.body')}</div>
            </span>
            <span className="spacer" />
            <span className="offer-acts">
              <Button variant="ghost" disabled={checking} onClick={() => void purchased()}>
                {checking ? t('settings.support.checking') : t('vr.offer.purchased')}
              </Button>
              <Button onClick={() => void electron.shell.openExternal(ITCH_URL)}>{t('vr.offer.itch')}</Button>
              <Button variant="primary" onClick={() => void electron.shell.openExternal(SUBSCRIBE_URL)}>
                {t('settings.support.become')}
              </Button>
            </span>
          </div>
        </div>
      )}
      <div className="set-censor-tools" inert={free}>
        <h3 className="eyebrow">{t('settings.gooner.hide')}</h3>
        <div className="panel">
          <ToolRow tool="censor" label={t('settings.gooner.hide')} on={censor.enabled} disabled={locked} onChange={(enabled) => void set({ enabled })} />
          <div className="prow kinds-row">
            <span className="lbl">{t('settings.gooner.what')}</span>
            <KindChips kinds={censor.kinds} locked={locked} onChange={(kinds) => void set({ kinds })} />
          </div>
          <div className="prow">
            <span className="lbl">{t('settings.gooner.style')}</span>
            <span className="spacer" />
            <Segmented options={STYLE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={censor.style} onChange={(style) => void set({ style })} label={t('settings.gooner.style')} />
          </div>
          <div className="prow">
            <span className="lbl">{t('settings.gooner.strength')}</span>
            <span className="spacer" />
            <div className="sl">
              <Slider
                value={[strength]}
                min={locked ? Math.round(censor.strength * 100) : 0}
                max={100}
                step={5}
                label={t('settings.gooner.strength')}
                onValueChange={([v]) => setDragging(v ?? null)}
                onValueCommit={([v]) => {
                  setDragging(null)
                  if (v !== undefined) void set({ strength: v / 100 })
                }}
              />
            </div>
            <span className="val">{strength}%</span>
          </div>
        </div>

        <h3 className="eyebrow">{t('settings.gooner.denial')}</h3>
        <div className="panel">
          <ToolRow tool="denial" label={t('settings.gooner.denial')} on={denialOn} disabled={locked && denial.enabled} onChange={(enabled) => void setDenial({ enabled })} />
          <div className="prow">
            <span className="lbl">{t('settings.gooner.while')}</span>
            <span className="spacer" />
            <Segmented options={WHEN_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={denial.when} onChange={(when) => void setDenial({ when })} label={t('settings.gooner.while')} disabled={locked} />
          </div>
          <div className="prow kinds-row">
            <span className="lbl">{t('settings.gooner.what')}</span>
            <KindChips kinds={denial.kinds} locked={locked} onChange={(kinds) => void setDenial({ kinds })} />
          </div>
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.gooner.clothing')}</div>
              <div className="sub">{t('settings.gooner.clothingHint')}</div>
            </span>
            <span className="spacer" />
            <Segmented options={CLOTHING_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={denial.clothing} onChange={(clothing) => void setDenial({ clothing })} label={t('settings.gooner.clothing')} disabled={locked} />
          </div>
          <div className="prow kinds-row" data-setting="axis-rules" tabIndex={-1}>
            <span className="lbl">{t('settings.gooner.axes')}</span>
            <AxisToggles axes={RULE_AXES} on={axisRules.map(([id]) => id)} variant="off" onChange={toggleAxes} />
          </div>
          {axisRules.map(([id, rule]) => (
            <div className="prow axrow" key={id}>
              <span className="axis">{AXIS_LABEL[id]}</span>
              <span className="lbl">{t(AXIS_NAME[id])}</span>
              <span className="spacer" />
              {rule.action === 'slower' && (
                <NumberInput value={Math.round(rule.by * 100)} min={5} max={95} unit="%" label={t('settings.gooner.slowerBy', { axis: t(AXIS_NAME[id]) })} onChange={(v) => setAxisRule(id, { by: v / 100 })} />
              )}
              <Segmented options={ACTION_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={rule.action} onChange={(action) => setAxisRule(id, { action })} label={t('settings.gooner.axisAction', { axis: t(AXIS_NAME[id]) })} disabled={locked} />
            </div>
          ))}
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.gooner.holdFor')}</div>
              <div className="sub">{t('settings.gooner.holdForHint')}</div>
            </span>
            <span className="spacer" />
            <NumberInput
              value={denial.holdMs / 1000}
              min={locked ? denial.holdMs / 1000 : 0}
              max={DENIAL_HOLD_MAX_MS / 1000}
              unit="s"
              label={t('settings.gooner.holdFor')}
              onChange={(v) => void setDenial({ holdMs: Math.round(v * 1000) })}
            />
          </div>
        </div>

        <h3 className="eyebrow">{t('settings.page.models')}</h3>
        <div className="panel">
          <ModelSizeRow />
        </div>

        <h3 className="eyebrow">{t('settings.gooner.lock')}</h3>
        <div className="panel">
          {locked ? (
            <div className="prow">
              <span>
                <div className="lbl">{t('settings.gooner.locked')}</div>
                <div className="sub">
                  {lockText}
                  {held && ` · ${held}`}
                </div>
              </span>
            </div>
          ) : (
            <div className="prow">
              <Select options={lockOptions} value={choice} onChange={setChoice} label={t('settings.gooner.lock')} />
              <span className="spacer" />
              <Button variant="primary" disabled={choice === 'off' || !anyOn} title={anyOn ? undefined : t('settings.gooner.lockFirst')} onClick={lock}>
                {t('settings.gooner.lock')}
              </Button>
            </div>
          )}
        </div>
        <SettingsLink page="chaster" />
      </div>
    </div>
  )
}

function ToolRow({ tool, label, on, disabled, onChange }: { tool: 'censor' | 'denial'; label: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const t = useT()
  const ready = useCensor((s) => s.detector === 'installed' || (tool === 'censor' && on && s.engineSetup !== null))
  const synced = useCensor((s) => s.synced)
  const cancellable = useCensor((s) => !s.locked && s.engineSetup === null)
  const downloadAndEnable = useCensor((s) => s.downloadAndEnable)
  const cancelDownload = useCensor((s) => s.cancelDownload)
  const size = sizeOf(useSettings((s) => s.settings?.tracking.models.detector))
  const download = useModels((s) => (size ? s.downloads[detectorId(size)] : undefined))

  if (ready || !synced) {
    return (
      <div className="prow">
        <span className="lbl">{label}</span>
        <span className="spacer" />
        <Switch checked={on} disabled={disabled} onCheckedChange={onChange} label={label} />
      </div>
    )
  }
  const running = download?.status === 'running' ? download : null
  const error = download?.status === 'error' ? download.error : null
  return (
    <div className="prow tool-download">
      <span>
        <div className="lbl">{label}</div>
        <div className={error ? 'sub error' : 'sub'}>{running ? `${percent(running)}%` : error ? t('settings.models.failed', { error }) : t('settings.models.notDownloaded')}</div>
      </span>
      <span className="spacer" />
      {running ? (
        cancellable && (
          <Button variant="ghost" onClick={() => void cancelDownload()}>
            {t('firstStart.tagging.cancelDownload')}
          </Button>
        )
      ) : (
        <Button onClick={() => void downloadAndEnable(tool)}>{t(error ? 'settings.models.download' : 'firstStart.tagging.downloadEnable')}</Button>
      )}
      {running && (
        <span className="dl-line">
          <i style={{ width: `${percent(running)}%` }} />
        </span>
      )}
    </div>
  )
}

function KindChips({ kinds, locked, onChange }: { kinds: DetectKindId[]; locked: boolean; onChange: (kinds: DetectKindId[]) => void }) {
  const t = useT()
  const toggle = (kind: DetectKindId) => {
    const on = kinds.includes(kind)
    if (on && locked) return
    const next = on ? kinds.filter((k) => k !== kind) : [...kinds, kind]
    if (next.length > 0) onChange(next)
  }
  return (
    <div className="kinds">
      {DETECT_KINDS.map((k) => {
        const on = kinds.includes(k.id)
        return (
          <Chip key={k.id} role="checkbox" aria-checked={on} aria-disabled={locked && on ? true : undefined} tabIndex={0} on={on} onClick={() => toggle(k.id)}>
            {t(k.label)}
          </Chip>
        )
      })}
    </div>
  )
}

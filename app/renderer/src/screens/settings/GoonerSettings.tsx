import { Lock } from 'lucide-react'
import { useState } from 'react'
import { SUBSCRIBE_URL } from '@shared/account'
import { AXIS_LABEL, AXIS_NAME, RULE_AXES, type AxisId } from '@shared/axes'
import { fmtSpan } from '@shared/chaster'
import {
  CLOTHING,
  CLOTHING_LABELS,
  DENIAL_ACTIONS,
  DENIAL_ACTION_LABELS,
  DENIAL_HOLD_MAX_MS,
  DENIAL_WHENS,
  DENIAL_WHEN_LABELS,
  DETECT_KINDS,
  GOONER_LOCK_MINUTES,
  GOONER_STYLES,
  GOONER_STYLE_LABELS,
  defaultDenialAxis,
  type DenialAxis,
  type DetectKindId,
} from '@shared/settings'
import { AxisToggles } from '@/components/media/AxisToggles'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { NumberInput } from '@/components/ui/NumberInput'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { electron } from '@/node'
import { isFree, useAccount } from '@/state/account'
import { t, useT } from '@/state/i18n'
import { useChaster, useMinuteClock } from '@/state/chaster'
import { useDenial } from '@/state/denial'
import { useGooner } from '@/state/gooner'
import { useTracking } from '@/state/tracking'
import { SettingsLink } from './SettingsSection'
import '@/components/media/AxisChips.css'

const STYLE_OPTIONS = GOONER_STYLES.map((value) => ({ value, label: GOONER_STYLE_LABELS[value] }))
const WHEN_OPTIONS = DENIAL_WHENS.map((value) => ({ value, label: DENIAL_WHEN_LABELS[value] }))
const CLOTHING_OPTIONS = CLOTHING.map((value) => ({ value, label: CLOTHING_LABELS[value] }))
const ACTION_OPTIONS = DENIAL_ACTIONS.map((value) => ({ value, label: DENIAL_ACTION_LABELS[value] }))

type LockChoice = 'off' | 'chaster' | `${(typeof GOONER_LOCK_MINUTES)[number]}`

const minutesLabel = (m: number) => (m < 60 ? t('settings.gooner.minutes', { count: m }) : t('settings.gooner.hours', { count: m / 60 }))

export function GoonerSettings() {
  const t = useT()
  const gooner = useGooner((s) => s.gooner)
  const locked = useGooner((s) => s.locked)
  const set = useGooner((s) => s.set)
  const denial = useDenial((s) => s.denial)
  const setDenial = useDenial((s) => s.set)
  const model = useTracking((s) => s.present.detector)
  const chasterLock = useChaster((s) => s.status.lock)
  const free = useAccount(isFree)
  const now = useMinuteClock()
  const [choice, setChoice] = useState<LockChoice>('off')
  const [asking, setAsking] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const strength = dragging ?? Math.round(gooner.strength * 100)

  const denialOn = denial.enabled && !free
  const anyOn = gooner.enabled || denialOn
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
    ...GOONER_LOCK_MINUTES.map((m) => ({ value: `${m}` as const, label: minutesLabel(m) })),
    { value: 'chaster', label: t('settings.gooner.untilChaster'), disabled: chasterLock === null, title: chasterLock === null ? t('settings.gooner.noChasterLock') : undefined },
  ]
  const lockText =
    gooner.lock?.kind === 'until'
      ? t('settings.gooner.timeLeft', { time: fmtSpan(gooner.lock.endsAt - now) })
      : chasterLock
        ? t('settings.gooner.chasterLocked', { time: fmtSpan(now - chasterLock.startedAt) })
        : t('settings.gooner.untilChaster')
  const held =
    gooner.enabled && denialOn
      ? t('settings.gooner.bothHold', { a: t('settings.gooner.hide'), b: t('settings.gooner.denial') })
      : gooner.enabled || denialOn
        ? t('settings.gooner.holds', { tool: t(gooner.enabled ? 'settings.gooner.hide' : 'settings.gooner.denial') })
        : null

  return (
    <div className="set-gooner">
      <h3 className="eyebrow">{t('settings.gooner.hide')}</h3>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.gooner.hide')}</span>
          <span className="spacer" />
          <Switch checked={gooner.enabled} disabled={locked} onCheckedChange={(enabled) => void set({ enabled })} label={t('settings.gooner.hide')} />
        </div>
        <div className="prow kinds-row">
          <span>
            <div className="lbl">{t('settings.gooner.what')}</div>
            {!model && <SettingsLink page="models" label={t('settings.gooner.noRegionModel')} />}
          </span>
          <KindChips kinds={gooner.kinds} locked={locked} onChange={(kinds) => void set({ kinds })} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.gooner.style')}</span>
          <span className="spacer" />
          <Segmented options={STYLE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={gooner.style} onChange={(style) => void set({ style })} label={t('settings.gooner.style')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.gooner.strength')}</span>
          <span className="spacer" />
          <div className="sl">
            <Slider
              value={[strength]}
              min={locked ? Math.round(gooner.strength * 100) : 0}
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

      <h3 className="eyebrow">
        {t('settings.gooner.denial')}
        {free && <Lock aria-label={t('common.supporterOnly')} />}
      </h3>
      {free && (
        <div>
          <Button onClick={() => setAsking(true)}>{t('common.supporterOnly')}</Button>
        </div>
      )}
      <div className="panel" inert={free}>
        <div className="prow">
          <span className="lbl">{t('settings.gooner.denial')}</span>
          <span className="spacer" />
          <Switch checked={denialOn} disabled={locked && denial.enabled} onCheckedChange={(enabled) => void setDenial({ enabled })} label={t('settings.gooner.denial')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.gooner.while')}</span>
          <span className="spacer" />
          <Segmented options={WHEN_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={denial.when} onChange={(when) => void setDenial({ when })} label={t('settings.gooner.while')} disabled={locked} />
        </div>
        <div className="prow kinds-row">
          <span>
            <div className="lbl">{t('settings.gooner.what')}</div>
            {!model && <SettingsLink page="models" label={t('settings.gooner.noRegionModel')} />}
          </span>
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
      <Prompt
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.gooner.denial')}
        body={t('settings.gooner.denialPromptBody')}
        cancelLabel={t('common.close')}
        confirmLabel={t('common.upgrade')}
        onConfirm={() => void electron.shell.openExternal(SUBSCRIBE_URL)}
      />
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

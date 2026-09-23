import { Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import { type SessionToySettings } from '@shared/session'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { NumberInput } from '@/components/ui/NumberInput'
import { Switch } from '@/components/ui/Switch'
import { outputName, useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import { useSession } from '@/state/session'
import { PeriodInputs } from './SessionTimeline'

const BAND_LABEL = { low: 'session.toys.band.low', middle: 'session.toys.band.middle', high: 'session.toys.band.high' } as const

function OutputScale({ value, onChange, label, binary = false }: { value: number; onChange: (n: number) => void; label: string; binary?: boolean }) {
  const t = useT()
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {(binary ? [0, 1] : [0, 0.25, 0.5, 0.75, 1]).map((n) => (
        <option key={n} value={n}>
          {n === 0 ? t('common.off') : `${n * 100}%`}
        </option>
      ))}
      {![0, 0.25, 0.5, 0.75, 1].includes(value) && <option value={value}>{Math.round(value * 100)}%</option>}
    </select>
  )
}

export function SessionToys({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const setup = useSession((s) => s.setup),
    setSetup = useSession((s) => s.setSetup),
    totalMs = useSession((s) => s.totalMs) || setup.totalMin * 60000
  const configured = useDevices((s) => s.outputs),
    toys = setup.toys
  const update = (patch: Partial<SessionToySettings>) => setSetup({ toys: { ...toys, ...patch } })
  const outputs = useMemo(() => {
    const current = configured.flatMap((o) => (o.config.id ? [{ id: o.config.id, name: outputName(o.config), binary: o.config.kind === 'howl', missing: false }] : []))
    const remembered = [...toys.rules, ...toys.periods]
    for (const rule of remembered) if (!current.some((o) => o.id === rule.outputId)) current.push({ id: rule.outputId, name: rule.name, binary: false, missing: true })
    return current
  }, [configured, toys.rules, toys.periods])
  const addPeriod = () => {
    const output = outputs.find((o) => !o.missing)
    if (output) update({ periods: [...toys.periods, { id: crypto.randomUUID(), outputId: output.id, name: output.name, from: 0, to: 0.25, scale: 0 }] })
  }
  return (
    <Modal title={t('session.toys.title')} width={740} open={open} onOpenChange={onOpenChange}>
      <div className="session-toys">
        <header>
          <div>
            <h2>{t('session.toys.title')}</h2>
            <p className="session-hint">{t('session.toys.hint')}</p>
          </div>
          <IconButton label={t('session.toys.close')} onClick={() => onOpenChange(false)}>
            <X />
          </IconButton>
        </header>
        <label className="opt">
          <span>{t('session.toys.useRules')}</span>
          <Switch label={t('session.toys.useRulesLabel')} checked={toys.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        </label>
        <fieldset disabled={!toys.enabled}>
          <h3>{t('session.toys.byIntensity')}</h3>
          <div className="toy-thresholds">
            <span>{t('session.toys.lowUpTo')}</span>
            <NumberInput
              label={t('session.toys.lowThreshold')}
              value={Math.round(toys.low * 100)}
              min={0}
              max={Math.round(toys.high * 100) - 1}
              unit="%"
              onChange={(low) => update({ low: low / 100 })}
            />
            <span>{t('session.toys.highFrom')}</span>
            <NumberInput
              label={t('session.toys.highThreshold')}
              value={Math.round(toys.high * 100)}
              min={Math.round(toys.low * 100) + 1}
              max={100}
              unit="%"
              onChange={(high) => update({ high: high / 100 })}
            />
          </div>
          <div className="toy-grid">
            <span>{t('session.toys.toy')}</span>
            <span>{t('session.toys.low')}</span>
            <span>{t('session.toys.middle')}</span>
            <span>{t('session.toys.high')}</span>
            {outputs.map((o) => {
              const rule = toys.rules.find((r) => r.outputId === o.id) ?? { outputId: o.id, name: o.name, low: 1, middle: 1, high: 1 }
              return (
                <div className="toy-grid-row" key={o.id}>
                  <span>
                    <b>{o.name}</b>
                    {o.binary && <small>{t('session.toys.onOffOnly')}</small>}
                    {o.missing && (
                      <>
                        <small className="session-error">{t('session.toys.notConfigured')}</small>
                        <Button
                          variant="ghost"
                          onClick={() => update({ rules: toys.rules.filter((r) => r.outputId !== o.id), periods: toys.periods.filter((r) => r.outputId !== o.id) })}
                        >
                          {t('session.toys.removeRules')}
                        </Button>
                      </>
                    )}
                  </span>
                  {(['low', 'middle', 'high'] as const).map((band) => (
                    <OutputScale
                      key={band}
                      label={t('session.toys.bandLabel', { name: o.name, band: t(BAND_LABEL[band]) })}
                      value={rule[band]}
                      binary={o.binary}
                      onChange={(scale) => update({ rules: [...toys.rules.filter((r) => r.outputId !== o.id), { ...rule, [band]: scale }] })}
                    />
                  ))}
                </div>
              )
            })}
          </div>
          {!outputs.length && <p className="session-hint">{t('session.toys.noOutputs')}</p>}
          {outputs.some((o) => o.missing) && <p className="session-hint">{t('session.toys.ignoredHint')}</p>}
          <p className="session-hint">{t('session.toys.scaleHint')}</p>
          <div className="timeline-heading">
            <h3>{t('session.toys.byTime')}</h3>
            <Button variant="ghost" disabled={!outputs.some((o) => !o.missing)} onClick={addPeriod}>
              <Plus />
              {t('session.timeline.addPeriod')}
            </Button>
          </div>
          <p className="session-hint">{t('session.toys.timeHint')}</p>
          <div className="toy-periods">
            {toys.periods.map((period) => {
              const change = (patch: Partial<typeof period>) => update({ periods: toys.periods.map((p) => (p.id === period.id ? { ...p, ...patch } : p)) })
              return (
                <div className="toy-period" key={period.id}>
                  <select
                    aria-label={t('session.toys.periodToy')}
                    value={period.outputId}
                    onChange={(e) => {
                      const o = outputs.find((o) => o.id === e.target.value)
                      if (o) change({ outputId: o.id, name: o.name, scale: o.binary && period.scale > 0 ? 1 : period.scale })
                    }}
                  >
                    {outputs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.missing ? t('session.toys.optionNotConfigured', { name: o.name }) : o.name}
                      </option>
                    ))}
                  </select>
                  <PeriodInputs period={period} totalMs={totalMs} onChange={change} />
                  <OutputScale
                    label={t('session.toys.periodOutput', { name: period.name })}
                    value={period.scale}
                    binary={outputs.find((o) => o.id === period.outputId)?.binary}
                    onChange={(scale) => change({ scale })}
                  />
                  <IconButton label={t('session.toys.removePeriod')} onClick={() => update({ periods: toys.periods.filter((p) => p.id !== period.id) })}>
                    <X />
                  </IconButton>
                </div>
              )
            })}
          </div>
          {useSession.getState().issues.some((i) => i.kind === 'toy-overlap') && (
            <p className="session-error" role="alert">
              {t('session.toys.overlap')}
            </p>
          )}
        </fieldset>
        <footer>
          <Button variant="ghost" onClick={() => update({ rules: [], periods: [] })}>
            {t('session.toys.clearRules')}
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t('common.done')}
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

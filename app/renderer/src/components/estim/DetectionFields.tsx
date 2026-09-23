import { DETECT_KINDS, type DetectKindId, type ParamAxisId, type ParamSourceSettings } from '@shared/settings'
import { AXIS_NAME } from '@shared/axes'
import { Chip } from '@/components/ui/Chip'
import { Slider } from '@/components/ui/Slider'
import { OptionStepper } from '@/components/ui/OptionStepper'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import { useParamHold } from '@/state/params'
import './DetectionFields.css'

const COVERAGE_STEPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50] as const

const pct = (v: number) => `${Math.round(v * 100)}%`
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`

interface Props {
  id: ParamAxisId
  param: ParamSourceSettings
  onChange: (patch: Partial<ParamSourceSettings>) => void
}

export function DetectionFields({ id, param, onChange }: Props) {
  const t = useT()
  const name = t(AXIS_NAME[id])
  const { held, coverage } = useParamHold(id, param)
  const toggleKind = (kind: DetectKindId) => {
    const kinds = param.kinds.includes(kind) ? param.kinds.filter((k) => k !== kind) : [...param.kinds, kind]
    if (kinds.length > 0) onChange({ kinds })
  }
  const peak = param.holdCoverageOver !== null
  const holding = param.holdOnCut || peak
  const next = param.holdOnCut && peak ? t('estim.nextCutOrPeak') : param.holdOnCut ? t('estim.nextCut') : t('estim.nextPeak')
  return (
    <>
      <div className="kinds">
        {DETECT_KINDS.map((k) => (
          <Chip key={k.id} role="checkbox" aria-checked={param.kinds.includes(k.id)} tabIndex={0} on={param.kinds.includes(k.id)} onClick={() => toggleKind(k.id)}>
            {t(k.label)}
          </Chip>
        ))}
      </div>
      <div className="dfrow">
        <span className="k">{t('estim.bias')}</span>
        <div className="bias-wrap">
          <Slider label={t('estim.biasLabel', { name })} value={[Math.round(param.bias * 100)]} min={-100} max={100} onValueChange={([v]) => v !== undefined && onChange({ bias: v / 100 })} />
        </div>
        <span className="val mono">{param.bias > 0 ? '+' : ''}{Math.round(param.bias * 100)}</span>
      </div>
      <div className="dfrow">
        <span className="k">{t('estim.changeOn')}</span>
        <div className="triggers">
          <Chip role="checkbox" aria-checked={param.holdOnCut} tabIndex={0} on={param.holdOnCut} onClick={() => onChange({ holdOnCut: !param.holdOnCut })}>
            {t('estim.sceneCut')}
          </Chip>
          <Chip role="checkbox" aria-checked={peak} tabIndex={0} on={peak} onClick={() => onChange({ holdCoverageOver: peak ? null : 0.01 })}>
            {t('estim.coverageOver')}
          </Chip>
          {peak && <OptionStepper label={t('estim.coverageThresholdLabel', { name })} value={(param.holdCoverageOver ?? 0) * 100} options={COVERAGE_STEPS} format={(v) => `${v.toFixed(1)}%`} onChange={(v) => onChange({ holdCoverageOver: v / 100 })} />}
        </div>
        <span className="val mono">{t('estim.now', { value: pct1(coverage) })}</span>
      </div>
      {holding && (
        <>
          <div className="dfrow">
            <span className="k">{t('estim.jump')}</span>
            <Slider label={t('estim.jumpLabel', { name })} value={[Math.round(param.jump * 100)]} onValueChange={([v]) => v !== undefined && onChange({ jump: v / 100 })} />
            <span className="val mono">{pct(param.jump)}</span>
          </div>
          <span className="held mono">{held ? t('estim.heldAt', { value: pct(held.value), since: fmtDuration(held.sinceMs), next }) : t('estim.waitingFirst', { next })}</span>
        </>
      )}
    </>
  )
}

import { bucketRgb, colourHex, DEFAULT_COLOUR_TOLERANCE, type ColourMatch } from '@shared/tracking'
import { Stepper } from '@/components/ui/Stepper'
import { useT } from '@/state/i18n'

export function ColourMatchFields({ bucket, value, name, onChange }: { bucket: number; value?: ColourMatch; name: string; onChange: (match: ColourMatch) => void }) {
  const t = useT()
  const match = value ?? { colour: bucketRgb(bucket), tolerance: DEFAULT_COLOUR_TOLERANCE }
  return (
    <div className="colour-match-fields">
      <label className="adv-field">
        <span>{t('tracking.colour')}</span>
        <span className="colour-match-picker">
          <input type="color" aria-label={t('tracking.colourLabel', { name })} value={colourHex(match.colour)} onChange={(event) => onChange({ ...match, colour: Number.parseInt(event.target.value.slice(1), 16) })} />
          <span>{colourHex(match.colour).toUpperCase()}</span>
        </span>
      </label>
      <div className="adv-field">
        <span>{t('tracking.colourTolerance')}</span>
        <Stepper value={Math.round(match.tolerance * 100)} min={0} max={100} format={(v) => value ? `${v}%` : t('tracking.preset')} label={t('tracking.colourToleranceLabel', { name })} onChange={(v) => onChange({ ...match, tolerance: v / 100 })} />
      </div>
    </div>
  )
}

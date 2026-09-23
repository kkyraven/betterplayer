import { useT } from '@/state/i18n'
import { Minus, Plus } from 'lucide-react'
import './Stepper.css'

interface Props {
  value: number
  options: readonly number[]
  format: (v: number) => string
  label: string
  onChange: (v: number) => void
}

export function OptionStepper({ value, options, format, label, onChange }: Props) {
  const t = useT()
  const index = options.reduce((best, o, i) => (Math.abs(o - value) < Math.abs((options[best] ?? 0) - value) ? i : best), 0)
  const step = (d: number) => {
    const next = options[Math.max(0, Math.min(options.length - 1, index + d))]
    if (next !== undefined && next !== value) onChange(next)
  }
  return (
    <div className="stepper">
      <button type="button" aria-label={t('common.decreaseLabel', { label })} disabled={index === 0} onClick={() => step(-1)}>
        <Minus />
      </button>
      <span className="stepper-v">{format(value)}</span>
      <button type="button" aria-label={t('common.increaseLabel', { label })} disabled={index === options.length - 1} onClick={() => step(1)}>
        <Plus />
      </button>
    </div>
  )
}

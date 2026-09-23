import { useT } from '@/state/i18n'
import { Minus, Plus } from 'lucide-react'
import './Stepper.css'

interface Props {
  value: number
  min?: number
  max: number
  step?: number
  format?: (v: number) => string
  label: string
  'data-label'?: string
  onChange: (v: number) => void
}

export function Stepper({ value, min = 0, max, step = 5, format = (v) => `${v}%`, label, onChange, ...rest }: Props) {
  const t = useT()
  const move = (d: number) => {
    const next = Math.max(min, Math.min(max, value + d * step))
    if (next !== value) onChange(next)
  }
  return (
    <div className="stepper" {...rest}>
      <button type="button" aria-label={t('common.decreaseLabel', { label })} disabled={value <= min} onClick={() => move(-1)}>
        <Minus />
      </button>
      <span className="stepper-v">{format(value)}</span>
      <button type="button" aria-label={t('common.increaseLabel', { label })} disabled={value >= max} onClick={() => move(1)}>
        <Plus />
      </button>
    </div>
  )
}

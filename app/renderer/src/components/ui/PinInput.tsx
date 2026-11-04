import { cx } from '@/lib/cx'
import './PinInput.css'

interface Props {
  value: string
  onChange: (digits: string) => void
  label: string
  length?: number
  invalid?: boolean
  autoFocus?: boolean
}

export function PinInput({ value, onChange, label, length = 4, invalid = false, autoFocus = false }: Props) {
  return (
    <div className={cx('pin-input', invalid && 'invalid')}>
      {Array.from({ length }, (_, i) => (
        <span key={i} className={cx('pin-box', i < value.length && 'filled', i === Math.min(value.length, length - 1) && 'next')}>
          {value[i] ?? ''}
        </span>
      ))}
      <input
        aria-label={label}
        aria-invalid={invalid}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        maxLength={length}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
      />
    </div>
  )
}

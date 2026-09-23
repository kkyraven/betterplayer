import { cx } from '@/lib/cx'
import { radioGroupKeyDown } from './radioKeys'
import './Segmented.css'

interface Props<T extends string> {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; title?: string }>
  value: T
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}

export function Segmented<T extends string>({ options, value, onChange, label, disabled = false }: Props<T>) {
  const tabStop = options.find((o) => o.value === value && !o.disabled) ?? options.find((o) => !o.disabled)
  return (
    <div className="seg" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={radioGroupKeyDown}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={!disabled && o === tabStop ? 0 : -1} className={cx(o.value === value && 'on')} disabled={disabled || o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

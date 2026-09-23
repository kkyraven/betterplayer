import type { ChangeEvent } from 'react'
import { cx } from '@/lib/cx'
import './Select.css'

interface Option<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
  hidden?: boolean
}

interface Props<T extends string> {
  options: ReadonlyArray<Option<T>>
  value: T
  onChange: (value: T) => void
  label: string
  title?: string
  className?: string
  disabled?: boolean
}

export function Select<T extends string>({ options, value, onChange, label, title, className, disabled = false }: Props<T>) {
  const change = (e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as T)
  return (
    <select className={cx('select', className)} value={value} aria-label={label} title={title} disabled={disabled} onChange={change}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title} hidden={o.hidden}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

import { useEffect, useState } from 'react'
import { cx } from '@/lib/cx'
import './NumberInput.css'

interface Props {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  unit?: string
  label: string
  digits?: number
  className?: string
}

export function NumberInput({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, unit, label, digits = 3, className }: Props) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])
  const commit = () => {
    setEditing(false)
    const n = Number(text.trim())
    if (!Number.isFinite(n)) return setText(String(value))
    const next = Math.min(max, Math.max(min, n))
    setText(String(next))
    if (next !== value) onChange(next)
  }
  return (
    <span className={cx('numf', className)}>
      <input
        inputMode="decimal"
        aria-label={label}
        value={text}
        style={{ width: `${digits + 1}ch` }}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(String(value))
            e.currentTarget.blur()
          }
        }}
      />
      {unit && <em>{unit}</em>}
    </span>
  )
}

import { cx } from '@/lib/cx'
import { radioGroupKeyDown } from './radioKeys'
import './Swatches.css'

interface Props<T extends string> {
  options: ReadonlyArray<{ value: T; label: string; colour: string | null }>
  value: T
  onChange: (value: T) => void
  label: string
}

export function Swatches<T extends string>({ options, value, onChange, label }: Props<T>) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label} onKeyDown={radioGroupKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (!options.some((option) => option.value === value) && o === options[0]) ? 0 : -1}
          aria-label={o.label}
          title={o.label}
          className={cx('swatch', o.colour === null && 'none')}
          style={o.colour === null ? undefined : { '--c': o.colour } as React.CSSProperties}
          onClick={() => onChange(o.value)}
        />
      ))}
    </div>
  )
}

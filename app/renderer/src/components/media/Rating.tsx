import { Star } from 'lucide-react'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import './Rating.css'

interface Props {
  value: number
  compact?: boolean
  onChange?: (value: number) => void
}

export function Rating({ value, compact = false, onChange }: Props) {
  const t = useT()
  const stars = compact ? Math.max(0, Math.min(5, value)) : 5
  if (stars === 0) return null
  return (
    <span className={cx('stars', onChange && 'stars-edit')} role={onChange ? 'radiogroup' : undefined} aria-label={onChange ? t('media.rating') : t('media.rated', { value })}>
      {Array.from({ length: stars }, (_, i) => {
        const n = i + 1
        const on = n <= value
        return onChange ? (
          <button key={n} type="button" role="radio" aria-checked={n === value} aria-label={t('media.stars', { count: n })} className={cx(!on && 'off')} onClick={() => onChange(n === value ? 0 : n)}>
            <Star />
          </button>
        ) : (
          <Star key={n} className={cx(!on && 'off')} />
        )
      })}
    </span>
  )
}

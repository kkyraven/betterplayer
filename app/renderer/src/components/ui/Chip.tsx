import type { HTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import './Chip.css'

interface Props extends HTMLAttributes<HTMLSpanElement> {
  on?: boolean
}

export function Chip({ on = false, className, ...rest }: Props) {
  return <span className={cx('chip', on && 'on', className)} {...rest} />
}

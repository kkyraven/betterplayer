import type { HTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import './Glass.css'

interface Props extends HTMLAttributes<HTMLDivElement> {
  strong?: boolean
}

export function Glass({ strong = false, className, ...rest }: Props) {
  return <div className={cx('glass', strong && 'glass-strong', className)} {...rest} />
}

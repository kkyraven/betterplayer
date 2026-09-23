import type { ButtonHTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import './Button.css'
import { useTooltipGroup } from './TooltipGroup'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost'
  icon?: boolean
}

export function Button({ variant = 'default', icon = false, className, type = 'button', ...rest }: Props) {
  const frosted = useTooltipGroup()
  return <button type={type} className={cx('btn', variant !== 'default' && `btn-${variant}`, icon && 'btn-icon', className)} {...rest} data-tooltip={frosted ? rest.title : undefined} title={frosted ? undefined : rest.title} />
}

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '@/lib/cx'
import './IconButton.css'
import { useTooltipGroup } from './TooltipGroup'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function IconButton({ label, size = 'md', className, type = 'button', ...rest }: Props) {
  const frosted = useTooltipGroup()
  return (
    <button type={type} className={cx('icon-btn', size === 'sm' && 'icon-btn-sm', size === 'lg' && 'icon-btn-lg', className)} aria-label={label} {...rest} title={frosted ? undefined : (rest.title ?? label)} />
  )
}

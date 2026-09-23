import { cx } from '@/lib/cx'
import './Switch.css'

interface Props {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  'data-label'?: string
  disabled?: boolean
}

export function Switch({ checked, onCheckedChange, label, disabled = false, ...rest }: Props) {
  return (
    <button {...rest} type="button" role="switch" aria-checked={checked} aria-label={label} className={cx('switch', checked && 'on')} disabled={disabled} onClick={() => onCheckedChange(!checked)} />
  )
}

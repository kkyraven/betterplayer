import { Check, Minus } from 'lucide-react'
import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import './Checkbox.css'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean
  mixed?: boolean
  onChange: (checked: boolean) => void
}

export function Checkbox({ checked, mixed = false, onChange, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <span className="checkbox">
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />
      <span aria-hidden>{mixed ? <Minus /> : <Check />}</span>
    </span>
  )
}

import { useEffect, useRef, type ReactNode } from 'react'
import './Toast.css'

interface Props {
  message: string
  action?: ReactNode
  onHide: () => void
  duration?: number
}

export function Toast({ message, action, onHide, duration = 6000 }: Props) {
  const hide = useRef(onHide)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    hide.current = onHide
  })
  const start = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => hide.current(), duration)
  }
  useEffect(() => {
    timer.current = setTimeout(() => hide.current(), duration)
    return () => clearTimeout(timer.current)
  }, [duration])
  return (
    <div className="toast" role="status" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={start}>
      <span>{message}</span>
      {action}
    </div>
  )
}

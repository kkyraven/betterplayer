import type { KeyboardEvent } from 'react'

export function radioGroupKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === ' ' || event.key === 'Enter') {
    event.stopPropagation()
    return
  }
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  const index = buttons.findIndex((button) => button === event.target)
  if (index < 0) return
  event.preventDefault()
  event.stopPropagation()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
  buttons[next]?.click()
}

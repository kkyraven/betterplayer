import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { MediaRow } from '@shared/library'
import { useUi } from '@/state/ui'

const DOUBLE_CLICK_MS = 1000
const HOLD_MS = 450
const HOLD_SLOP_PX = 16

export function tileOptionsKey(e: KeyboardEvent<HTMLElement>, rows: MediaRow[]) {
  if (e.key !== 'o' && e.key !== 'O' && e.key !== 'ContextMenu') return
  const id = Number((e.target as HTMLElement).closest('[data-media-id]')?.getAttribute('data-media-id'))
  const row = rows.find((r) => r.id === id)
  if (!row) return
  e.preventDefault()
  e.stopPropagation()
  useUi.getState().openTvOptions(row)
}

export function tileOptionsMenu(e: ReactMouseEvent<HTMLDivElement>, row: MediaRow) {
  e.preventDefault()
  useUi.getState().openTvOptions(row)
}

export function holdForOptions(e: ReactPointerEvent<HTMLDivElement>, row: MediaRow) {
  if (e.button !== 0) return
  const x = e.clientX
  const y = e.clientY
  const done = () => {
    window.clearTimeout(timer)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', done)
    window.removeEventListener('pointercancel', done)
  }
  const move = (m: PointerEvent) => {
    if (Math.hypot(m.clientX - x, m.clientY - y) > HOLD_SLOP_PX) done()
  }
  const timer = window.setTimeout(() => {
    done()
    useUi.getState().openTvOptions(row)
  }, HOLD_MS)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', done)
  window.addEventListener('pointercancel', done)
}

export function playOnClick(rows: readonly MediaRow[], play: (row: MediaRow) => void) {
  return (id: number) => {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    const drop = (e: MouseEvent) => {
      if (e.detail < 2) return
      e.stopPropagation()
      e.preventDefault()
    }
    for (const type of ['mousedown', 'click', 'dblclick'] as const) {
      window.addEventListener(type, drop, { capture: true })
      window.setTimeout(() => window.removeEventListener(type, drop, { capture: true }), DOUBLE_CLICK_MS)
    }
    play(row)
  }
}

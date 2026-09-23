import type { KeyboardEvent } from 'react'
import type { MediaRow } from '@shared/library'
import { useUi } from '@/state/ui'

export function tileOptionsKey(e: KeyboardEvent<HTMLElement>, rows: MediaRow[]) {
  if (e.key !== 'o' && e.key !== 'O' && e.key !== 'ContextMenu') return
  const id = Number((e.target as HTMLElement).closest('[data-media-id]')?.getAttribute('data-media-id'))
  const row = rows.find((r) => r.id === id)
  if (!row) return
  e.preventDefault()
  e.stopPropagation()
  useUi.getState().openTvOptions(row)
}

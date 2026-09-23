import { useState, type PointerEvent } from 'react'
import type { MediaRow } from '@shared/library'
import { useLibrary } from '@/state/library'
import { useSettings } from '@/state/settings'

export function useHoverPreview(row: MediaRow, disabled = false) {
  const enabled = useSettings((s) => s.settings?.library.stashPreviews ?? true)
  const stash = useLibrary((s) => s.roots.some((root) => root.id === row.rootId && root.kind === 'stash'))
  const [hovered, setHovered] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [frame, setFrame] = useState<number | null>(null)
  const source = `thumb://preview/${row.id}?v=${row.mtime}`
  const preview = !disabled && enabled && stash && hovered && failed !== source ? source : null
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.pointerType === 'touch') return
    if (event.type === 'pointerenter') setFailed(null)
    setHovered(true)
    if (!row.strip) return
    const rect = event.currentTarget.getBoundingClientRect()
    setFrame(Math.max(0, Math.min(19, Math.floor(((event.clientX - rect.left) / rect.width) * 20))))
  }
  return {
    preview,
    frame: disabled ? null : frame,
    failed: () => setFailed(source),
    handlers: {
      onPointerEnter: move,
      onPointerMove: move,
      onPointerLeave: () => { setHovered(false); setFrame(null) },
    },
  }
}

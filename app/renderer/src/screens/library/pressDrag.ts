import type { PointerEvent as ReactPointerEvent } from 'react'
import { isPlaylist, type MediaRow } from '@shared/library'
import { useLibrary } from '@/state/library'
import { parseDrop, useSelect, type DropTarget } from '@/state/select'

const LONG_PRESS_MS = 450
const DRAG_PX = 6
const GHOST_THUMBS = 3

let suppressClick = false

export function consumeSuppressedClick(): boolean {
  const was = suppressClick
  suppressClick = false
  return was
}

export function pressDown(e: ReactPointerEvent<HTMLDivElement>, row: MediaRow) {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest('.card-menu, .card-play'))) return
  const el = e.currentTarget
  const startX = e.clientX
  const startY = e.clientY
  const canDrag = e.pointerType === 'mouse' || useSelect.getState().on
  let dragging = false
  let pressed = false

  const timer = window.setTimeout(() => {
    pressed = true
    if (!useSelect.getState().on) useSelect.getState().start(row.id)
  }, LONG_PRESS_MS)

  const cleanup = () => {
    window.clearTimeout(timer)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    document.body.classList.remove('is-dragging')
  }
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return
      window.clearTimeout(timer)
      if (!canDrag) {
        cleanup()
        return
      }
      dragging = true
      el.setPointerCapture(ev.pointerId)
      const s = useSelect.getState()
      const ids = s.on && s.ids.has(row.id) ? [row.id, ...[...s.ids].filter((id) => id !== row.id)] : [row.id]
      s.setDrag({ ids, thumbs: thumbsFor(ids, row), x: ev.clientX, y: ev.clientY })
      document.body.classList.add('is-dragging')
    }
    useSelect.getState().moveDrag(ev.clientX, ev.clientY)
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-drop]')
    useSelect.getState().setDropTarget(target?.dataset.drop ?? null)
  }
  const up = () => {
    cleanup()
    if (dragging || pressed) {
      suppressClick = true
      window.setTimeout(() => (suppressClick = false), 0)
    }
    if (!dragging) return
    const { drag, dropTarget } = useSelect.getState()
    if (drag && dropTarget) void dropOn(parseDrop(dropTarget), drag.ids)
    useSelect.getState().setDrag(null)
  }
  const cancel = () => {
    cleanup()
    useSelect.getState().setDrag(null)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
}

function thumbsFor(ids: number[], first: MediaRow): (string | null)[] {
  const { rows, continueRows } = useLibrary.getState()
  const byId = new Map<number, string | null>()
  for (const r of rows) if (!isPlaylist(r)) byId.set(r.id, r.thumb)
  for (const r of continueRows) byId.set(r.id, r.thumb)
  return ids.slice(0, GHOST_THUMBS).map((id) => (id === first.id ? first.thumb : (byId.get(id) ?? null)))
}

function dropOn(target: DropTarget, ids: number[]): Promise<void> {
  const lib = useLibrary.getState()
  switch (target.kind) {
    case 'favourites':
      return lib.setFavourite(ids, true)
    case 'playlist':
      return lib.addToPlaylist(target.id, ids)
    case 'newPlaylist':
      useSelect.getState().setPendingPlaylist(ids)
      return Promise.resolve()
    case 'tag':
      return lib.addTag(ids, target.name)
    case 'folder':
      return lib.moveToFolder(ids, target.folder)
  }
}

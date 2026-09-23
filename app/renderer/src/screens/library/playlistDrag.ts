import type { PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { isPlaylist, type MediaRow } from '@shared/library'
import type { PlaylistMove } from '@shared/playlist'
import { t } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSelect } from '@/state/select'

interface Marker { left: number; top: number; width: number; height: number }
export const usePlaylistDrag = create<{ marker: Marker | null; announcement: string }>(() => ({ marker: null, announcement: '' }))

export function canReorderPlaylist(state: ReturnType<typeof useLibrary.getState>) {
  return state.playlistId !== null && state.movingPlaylist === null && !state.loading && !state.search.trim() && Object.values(state.filters).every(v => v === undefined || (Array.isArray(v) && v.length === 0))
}

function selectedIds(row: MediaRow): number[] {
  const selection = useSelect.getState()
  return selection.on && selection.ids.has(row.id) ? [...selection.ids] : [row.id]
}

async function saveMove(playlistId: number, move: PlaylistMove) {
  usePlaylistDrag.setState({ announcement: '' })
  await useLibrary.getState().movePlaylistItems(playlistId, move)
  if (useLibrary.getState().playlistId === playlistId && !useLibrary.getState().playlistError) usePlaylistDrag.setState({ announcement: t('library.playlist.reordered') })
}

export async function movePlaylistRow(row: MediaRow, direction: -1 | 1) {
  const state = useLibrary.getState()
  if (!canReorderPlaylist(state) || state.playlistId === null) return
  const ids = selectedIds(row)
  const picked = new Set(ids)
  let rows = state.rows
  const boundary = () => direction === -1 ? rows.findIndex(r => picked.has(r.id)) : rows.map(r => picked.has(r.id)).lastIndexOf(true)
  if (direction === 1 && boundary() === rows.length - 1 && rows.length < state.total) {
    await state.loadMore()
    if (useLibrary.getState().playlistId !== state.playlistId || !canReorderPlaylist(useLibrary.getState())) return
    rows = useLibrary.getState().rows
  }
  const anchor = rows[boundary() + direction]
  if (boundary() < 0 || !anchor || isPlaylist(anchor)) return
  await saveMove(state.playlistId, { mediaIds: ids, anchorId: anchor.id, side: direction === -1 ? 'before' : 'after' })
  if (useLibrary.getState().playlistId === state.playlistId) document.querySelector<HTMLElement>(`[data-playlist-item][data-media-id="${row.id}"] .playlist-handle`)?.focus({ preventScroll: true })
}

export function playlistPointerDown(e: ReactPointerEvent<HTMLButtonElement>, row: MediaRow) {
  e.stopPropagation()
  const state = useLibrary.getState()
  if (e.button !== 0 || !e.isPrimary || !canReorderPlaylist(state) || state.playlistId === null || useSelect.getState().drag) return
  const scroll = e.currentTarget.closest<HTMLElement>('.lib-scroll')
  const grid = scroll?.querySelector<HTMLElement>('[data-playlist-grid]')
  if (!scroll || !grid) return
  const playlistId = state.playlistId, pointerId = e.pointerId
  const start = { x: e.clientX, y: e.clientY }
  let point = start, dragging = false, frame = 0, previousFrame = 0, cleaned = false
  let move: PlaylistMove | null = null
  const ids = selectedIds(row), picked = new Set(ids)
  const sourceRows = state.rows.filter((r): r is MediaRow => !isPlaylist(r) && picked.has(r.id))
  const mark = () => {
    move = null
    usePlaylistDrag.setState({ marker: null })
    const bounds = scroll.getBoundingClientRect()
    const top = scroll.querySelector('.lib-sticky')?.getBoundingClientRect().bottom ?? bounds.top
    if (point.x < bounds.left || point.x > bounds.right || point.y < top || point.y > bounds.bottom) return
    let target: HTMLElement | undefined, distance = Infinity
    for (const card of grid.querySelectorAll<HTMLElement>('[data-playlist-item]')) {
      card.classList.toggle('playlist-drag-source', picked.has(Number(card.dataset.mediaId)))
      const rect = card.getBoundingClientRect()
      const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
      const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
      const d = dx * dx + dy * dy
      if (d < distance) { target = card; distance = d }
    }
    if (!target || picked.has(Number(target.dataset.mediaId))) return
    const rect = target.getBoundingClientRect(), isGrid = state.view === 'grid'
    const after = isGrid ? point.y > rect.bottom || (point.y >= rect.top && point.x > rect.left + rect.width / 2) : point.y > rect.top + rect.height / 2
    move = { mediaIds: ids, anchorId: Number(target.dataset.mediaId), side: after ? 'after' : 'before' }
    const gap = parseFloat(getComputedStyle(grid)[isGrid ? 'columnGap' : 'rowGap']) || 0
    usePlaylistDrag.setState({ marker: isGrid
      ? { left: (after ? rect.right + gap / 2 : rect.left - gap / 2) - 1, top: rect.top, width: 2, height: rect.height }
      : { left: rect.left, top: (after ? rect.bottom + gap / 2 : rect.top - gap / 2) - 1, width: rect.width, height: 2 } })
  }
  const tick = (time: number) => {
    if (!scroll.isConnected) { cancel(); return }
    frame = requestAnimationFrame(tick)
    if (time - previousFrame < 1000 / 60) return
    const elapsed = Math.min(40, time - previousFrame)
    previousFrame = time
    const bounds = scroll.getBoundingClientRect()
    const top = scroll.querySelector('.lib-sticky')?.getBoundingClientRect().bottom ?? bounds.top
    if (point.x >= bounds.left && point.x <= bounds.right && point.y >= top && point.y <= bounds.bottom) {
      const speed = point.y < top + 60 ? -Math.min(1, (top + 60 - point.y) / 60) : point.y > bounds.bottom - 60 ? Math.min(1, (point.y - bounds.bottom + 60) / 60) : 0
      if (speed) scroll.scrollTop += speed * elapsed * .65
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 200) void useLibrary.getState().loadMore()
    }
    mark()
  }
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', cancel)
    scroll.removeEventListener('lostpointercapture', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', onKey, true)
    unsubscribe()
    if (scroll.hasPointerCapture(pointerId)) scroll.releasePointerCapture(pointerId)
    grid.querySelectorAll('.playlist-drag-source').forEach(el => el.classList.remove('playlist-drag-source'))
    document.body.classList.remove('is-dragging')
    useSelect.getState().setDrag(null)
    usePlaylistDrag.setState({ marker: null })
  }
  const cancel = () => cleanup()
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel() }
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    point = { x: ev.clientX, y: ev.clientY }
    if (!dragging) {
      if (Math.hypot(point.x - start.x, point.y - start.y) < 6) return
      dragging = true
      scroll.setPointerCapture(pointerId)
      document.body.classList.add('is-dragging')
      useSelect.getState().setDrag({ ids, thumbs: sourceRows.slice(0, 3).map(r => r.thumb), ...point })
      frame = requestAnimationFrame(tick)
    }
    useSelect.getState().moveDrag(point.x, point.y)
    mark()
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    if (dragging) { point = { x: ev.clientX, y: ev.clientY }; mark() }
    const destination = move
    cleanup()
    if (dragging && destination) void saveMove(playlistId, destination)
  }
  const unsubscribe = useLibrary.subscribe(s => {
    if (s.playlistId !== playlistId || s.view !== state.view || s.search !== state.search || s.filters !== state.filters) cancel()
  })
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cancel)
  scroll.addEventListener('lostpointercapture', cancel)
  window.addEventListener('blur', cancel)
  window.addEventListener('keydown', onKey, true)
}

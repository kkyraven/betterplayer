import { GripVertical, Play, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { MediaRow } from '@shared/library'
import type { PlaylistMove } from '@shared/playlist'
import { ThumbnailImage } from '@/components/media/ThumbnailImage'
import { IconButton } from '@/components/ui/IconButton'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { invoke } from '@/ipc'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useSession } from '@/state/session'
import './QueueSheet.css'

export function QueueSheet() {
  const playlist = usePlayer(s => s.playlist)
  const inSession = useSession(s => s.stage === 'running')
  if (!playlist || inSession) return null
  return <QueueContents key={playlist.id} playlist={playlist} />
}

function QueueContents({ playlist }: { playlist: NonNullable<ReturnType<typeof usePlayer.getState>['playlist']> }) {
  const t = useT()
  const name = useLibrary(s => s.playlists.find(p => p.id === playlist.id)?.name)
  const moveQueue = usePlayer(s => s.moveQueue)
  const jumpQueue = usePlayer(s => s.jumpQueue)
  const [rows, setRows] = useState<Map<number, MediaRow | null>>(new Map())
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [dragged, setDragged] = useState<number | null>(null)
  const [target, setTarget] = useState<{ id: number; side: 'before' | 'after' } | null>(null)
  const current = useRef<HTMLLIElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const members = [...playlist.ids].sort((a, b) => a - b).join(',')
  useEffect(() => {
    let cancelled = false
    const ids = members ? members.split(',').map(Number) : []
    void Promise.all(ids.map(async id => [id, await invoke('library:media', id)] as const))
      .then(entries => { if (!cancelled) setRows(new Map(entries)) })
      .catch(() => { if (!cancelled) setError(t('player.queue.unavailable')) })
    return () => { cancelled = true }
  }, [members])
  useEffect(() => {
    close.current?.focus({ preventScroll: true })
    return () => {
      if (usePlayer.getState().sheet === null) document.getElementById('queue-toggle')?.focus({ preventScroll: true })
    }
  }, [])
  const currentId = playlist.ids[playlist.index]
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  const finishDrag = () => { setDragged(null); setTarget(null) }
  const reorder = (move: PlaylistMove) => {
    moveQueue(move)
    const queue = usePlayer.getState().playlist
    const id = move.mediaIds[0]
    if (queue && id !== undefined) setAnnouncement(t('player.queue.moved', { title: rows.get(id)?.title ?? t('player.queue.video'), position: queue.ids.indexOf(id) + 1, total: queue.ids.length }))
  }
  const dragOver = (event: DragEvent<HTMLLIElement>, id: number) => {
    if (dragged === null || dragged === id) { setTarget(null); return }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const side = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    if (target?.id !== id || target.side !== side) setTarget({ id, side })
  }
  const jump = async (id: number) => {
    setError('')
    try { await jumpQueue(id) } catch { setError(t('player.queue.videoUnavailable')) }
  }

  return (
    <TooltipGroup as="aside" className="psheet queue-sheet" id="player-queue" aria-label={t('player.queue.title')}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key !== 'Escape') e.stopPropagation()
        else if (dragged !== null) { e.stopPropagation(); finishDrag() }
      }}>
      <div className="hd">
        <div className="queue-heading"><h2>{t('player.queue.title')}</h2>{name && <span>{name}</span>}</div>
        <span className="queue-count">{playlist.index + 1} / {playlist.ids.length}</span>
        <button ref={close} type="button" className="icon-btn icon-btn-sm" aria-label={t('player.queue.close')} onClick={() => usePlayer.getState().setSheet(null)}><X /></button>
      </div>
      {error && <div className="queue-error" role="alert">{error}</div>}
      <ol className="queue-items" onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setTarget(null) }}>
        {playlist.ids.map((id, index) => {
          const row = rows.get(id)
          const unavailable = rows.has(id) && !row
          const playing = index === playlist.index
          return (
            <li key={id} ref={playing ? current : undefined} className="queue-item" data-current={playing || undefined} data-dragged={dragged === id || undefined} data-drop={target?.id === id ? target.side : undefined}
              onDragOver={e => dragOver(e, id)}
              onDrop={e => {
                e.preventDefault()
                if (dragged !== null && target?.id === id) {
                  reorder({ mediaIds: [dragged], anchorId: id, side: target.side })
                }
                finishDrag()
              }}>
              <IconButton label={t('player.queue.reorderItem', { name: row?.title ?? index + 1 })} data-tooltip={t('player.queue.reorder')} className="queue-grip" draggable aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onDragStart={e => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(id))
                  setDragged(id)
                }}
                onDragEnd={finishDrag}
                onKeyDown={e => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault()
                    const direction = e.key === 'ArrowUp' ? -1 : 1
                    const anchor = playlist.ids[index + direction]
                    if (anchor !== undefined) {
                      reorder({ mediaIds: [id], anchorId: anchor, side: direction === -1 ? 'before' : 'after' })
                    }
                  }
                }}><GripVertical /></IconButton>
              <button className="queue-play" type="button" disabled={!row} aria-current={playing ? 'true' : undefined} onClick={() => void jump(id)}>
                <span className="queue-position">{playing ? <Play /> : index + 1}</span>
                <span className="queue-thumb">{row?.thumb && <ThumbnailImage src={row.thumb} alt="" draggable={false} loading="lazy" />}</span>
                <span className="queue-details"><span className="queue-name">{row?.title ?? (unavailable ? t('player.queue.videoUnavailable') : t('player.queue.loading'))}</span><span className="queue-duration">{playing && t('player.queue.playing')}{playing && row && ' · '}{row && fmtDuration(row.durationMs)}</span></span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="ft">{t('player.queue.currentOnly')}</div>
      <span className="sr-only" role="status">{announcement}</span>
    </TooltipGroup>
  )
}

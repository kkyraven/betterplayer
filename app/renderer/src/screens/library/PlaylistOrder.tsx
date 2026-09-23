import { GripVertical } from 'lucide-react'
import type { MediaRow } from '@shared/library'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { canReorderPlaylist, movePlaylistRow, playlistPointerDown, usePlaylistDrag } from './playlistDrag'
import './PlaylistOrder.css'

export function PlaylistOrder({ row }: { row: MediaRow }) {
  const t = useT()
  const enabled = useLibrary(canReorderPlaylist)
  const searching = useLibrary(s => s.search.trim() !== '')
  return (
    <div className="playlist-order" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      <button type="button" className="playlist-handle" aria-label={t('library.playlist.reorder')} title={enabled ? t('library.playlist.dragToReorder') : searching ? t('library.playlist.clearSearchFirst') : t('library.playlist.reorderUnavailable')} disabled={!enabled}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onPointerDown={e => playlistPointerDown(e, row)}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault()
            void movePlaylistRow(row, e.key === 'ArrowUp' ? -1 : 1)
          }
        }}><GripVertical /></button>
      <span className="playlist-position">{row.playlistPosition}</span>
    </div>
  )
}

export function PlaylistInsertion() {
  const marker = usePlaylistDrag(s => s.marker)
  const announcement = usePlaylistDrag(s => s.announcement)
  return <><span className="sr-only" role="status">{announcement}</span>{marker && <div className="playlist-insertion" style={marker} />}</>
}

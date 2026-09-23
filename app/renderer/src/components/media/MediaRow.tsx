import { Check, Pin } from 'lucide-react'
import { memo, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { MediaRow as MediaRowData } from '@shared/library'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { AxisChips } from './AxisChips'
import { HeatStrip } from './HeatStrip'
import { resolutionLabel } from './MediaCard'
import { Rating } from './Rating'
import { ThumbnailImage } from './ThumbnailImage'
import { SearchMatch } from './SearchMatch'
import { useHoverPreview } from './useHoverPreview'
import { HoverPreview } from './HoverPreview'
import './MediaRow.css'

interface Props {
  row: MediaRowData
  selected?: boolean
  condensed?: boolean
  onSelect: (id: number) => void
  onPlay: (row: MediaRowData) => void
  menu?: ReactNode
  checked?: boolean
  order?: ReactNode
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>, row: MediaRowData) => void
  onContextMenu?: (e: MouseEvent<HTMLDivElement>, row: MediaRowData) => void
}

const STRIP_FRAMES = 20

export const MediaRow = memo(function MediaRow({ row, selected = false, condensed = false, onSelect, onPlay, menu, checked, order, onPointerDown, onContextMenu }: Props) {
  const t = useT()
  const axisBadges = useSettings((s) => s.settings?.library.axisBadges) ?? true
  const hover = useHoverPreview(row, condensed)
  const { frame } = hover
  const watched = row.watchedMs !== null && row.durationMs > 0 ? Math.min(1, row.watchedMs / row.durationMs) : null
  const projection = row.projection !== 'flat' ? t('media.vr', { degrees: row.projection === 'equirect360' ? '360' : '180' }) : null

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onPlay(row)
    } else if (e.key === ' ') {
      e.preventDefault()
      onSelect(row.id)
    }
  }

  const selecting = checked !== undefined
  return (
    <div
      className={cx('mrow', condensed && 'mrow-c', selected && 'selected', row.hidden && 'hidden', selecting && 'selecting', checked && 'picked')}
      tabIndex={0}
      role="option"
      aria-selected={selecting ? checked : selected}
      data-media-id={row.id}
      data-playlist-item={order ? '' : undefined}
      onClick={() => onSelect(row.id)}
      onDoubleClick={selecting ? undefined : () => onPlay(row)}
      onKeyDown={onKey}
      onPointerDown={onPointerDown && ((e) => onPointerDown(e, row))}
      onContextMenu={onContextMenu && ((e) => onContextMenu(e, row))}
    >
      {order}
      <div className="thumb" {...hover.handlers}>
        {row.thumb && <ThumbnailImage className="poster" src={row.thumb} alt="" draggable={false} loading="lazy" decoding="async" />}
        {selecting && <span className="sel">{checked && <Check />}</span>}
        {!condensed && row.strip && frame !== null && (
          <div className="strip" style={{ backgroundImage: `url(${row.strip})`, backgroundPositionX: `${(frame / (STRIP_FRAMES - 1)) * 100}%` }} />
        )}
        {hover.preview && <HoverPreview key={hover.preview} src={hover.preview} onError={hover.failed} />}
        {!condensed && axisBadges && (
          <div className="tl">
            <AxisChips axes={row.axes} />
          </div>
        )}
        {!condensed && projection && (
          <div className="tr">
            <span className="badge-res">{projection}</span>
          </div>
        )}
        {!condensed && watched !== null && (
          <div className="prog">
            <i style={{ width: `${watched * 100}%` }} />
          </div>
        )}
      </div>
      {condensed ? (
        <>
          <div className="title" title={row.title}>
            {row.pinned && <Pin />}
            {row.title}
          </div>
          <span className="ax">{projection ?? row.axes.join(' ')}</span>
          <HeatStrip heat={row.heat} />
          <span className="res">{row.height > 0 ? resolutionLabel(row.height) : ''}</span>
          <span className="d">{fmtDuration(row.durationMs)}</span>
          {row.rating > 0 ? <Rating value={row.rating} compact /> : <span className="stars" />}
        </>
      ) : (
        <>
          <div className="mrow-main">
            <div className="title" title={row.title}>
              {row.pinned && <Pin />}
              {row.title}
            </div>
            <div className="meta">
              {row.folder && <span className="folder">{row.folder}</span>}
              {row.folder && row.height > 0 && <span className="sep" />}
              {row.height > 0 && <span>{resolutionLabel(row.height)}</span>}
              {row.axes.length > 0 && (row.folder || row.height > 0) && <span className="sep" />}
              {row.axes.length > 0 && <span className="axlist">{row.axes.join(' ')}</span>}
            </div>
            <HeatStrip heat={row.heat} />
            <SearchMatch match={row.searchMatch} />
          </div>
          <div className="mrow-side">
            <span className="d">{fmtDuration(row.durationMs)}</span>
            {row.rating > 0 && <Rating value={row.rating} compact />}
          </div>
        </>
      )}
      {menu && (
        <div className="card-menu" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {menu}
        </div>
      )}
    </div>
  )
})

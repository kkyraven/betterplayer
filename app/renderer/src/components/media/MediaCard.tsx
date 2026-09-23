import { Check, Pin, Play } from 'lucide-react'
import { memo, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { MediaRow } from '@shared/library'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { IconButton } from '@/components/ui/IconButton'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { AxisChips } from './AxisChips'
import { HeatStrip } from './HeatStrip'
import { Rating } from './Rating'
import { ThumbnailImage } from './ThumbnailImage'
import { SearchMatch } from './SearchMatch'
import { useHoverPreview } from './useHoverPreview'
import { HoverPreview } from './HoverPreview'
import './MediaCard.css'

export type Density = 'comfortable' | 'compact' | 'tenfoot'

interface Props {
  row: MediaRow
  selected?: boolean
  resume?: boolean
  density?: Density
  onSelect: (id: number) => void
  onPlay: (row: MediaRow) => void
  menu?: ReactNode
  checked?: boolean
  order?: ReactNode
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>, row: MediaRow) => void
  onContextMenu?: (e: MouseEvent<HTMLDivElement>, row: MediaRow) => void
}

const STRIP_FRAMES = 20

export function resolutionLabel(height: number): string {
  if (height >= 4320) return '8K'
  if (height >= 2160) return '4K'
  if (height >= 1440) return '1440p'
  if (height >= 1080) return '1080p'
  return height > 0 ? `${height}p` : ''
}

export const MediaCard = memo(function MediaCard({ row, selected = false, resume = false, density = 'comfortable', onSelect, onPlay, menu, checked, order, onPointerDown, onContextMenu }: Props) {
  const t = useT()
  const axisBadges = useSettings((s) => s.settings?.library.axisBadges) ?? true
  const hover = useHoverPreview(row)
  const { frame } = hover
  const watched = row.watchedMs !== null && row.durationMs > 0 ? Math.min(1, row.watchedMs / row.durationMs) : null

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
      className={cx('card', `card-${density}`, selected && 'selected', row.hidden && 'hidden', selecting && 'selecting', checked && 'picked')}
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
      {order && <div className="playlist-card-order">{order}<div className="card-menu" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>{menu}</div></div>}
      <div className="thumb" {...hover.handlers}>
        {row.thumb && <ThumbnailImage className="poster" src={row.thumb} alt="" draggable={false} loading="lazy" decoding="async" />}
        {selecting && <span className="sel">{checked && <Check />}</span>}
        {row.strip && frame !== null && (
          <div className="strip" style={{ backgroundImage: `url(${row.strip})`, backgroundPositionX: `${(frame / (STRIP_FRAMES - 1)) * 100}%` }} />
        )}
        {hover.preview && <HoverPreview key={hover.preview} src={hover.preview} onError={hover.failed} />}
        {density !== 'tenfoot' && !selecting && (
          <IconButton
            label={t('media.play', { title: row.title })}
            size="lg"
            className="card-play"
            onClick={(e) => {
              e.stopPropagation()
              onPlay(row)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Play />
          </IconButton>
        )}
        {axisBadges && (
          <div className="tl">
            <AxisChips axes={row.axes} />
          </div>
        )}
        <div className="tr">
          {row.pinned && <span className="badge-pin" title={t('media.pinned')}><Pin /></span>}
          {row.projection !== 'flat' && <span className="badge-res">{t('media.vr', { degrees: row.projection === 'equirect360' ? '360' : '180' })}</span>}
          {menu && !order && <div className="card-menu" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{menu}</div>}
        </div>
        {resume && watched !== null && <div className="bl"><span className="resume">{t('media.timeLeft', { time: fmtDuration(row.durationMs - (row.watchedMs ?? 0)) })}</span></div>}
        <div className="br"><span className="dur">{fmtDuration(row.durationMs)}</span></div>
        {watched !== null && (
          <div className="prog">
            <i style={{ width: `${watched * 100}%` }} />
          </div>
        )}
      </div>
      <HeatStrip heat={row.heat} />
      <div className="text">
        <div className="title" title={row.title}>
          {row.title}
        </div>
        <div className="rowm meta">
          {!!row.performers?.length && <span className="folder">{row.performers.map((p) => p.name).join(', ')}</span>}
          {!!row.performers?.length && row.folder && <span className="sep" />}
          {row.folder && <span className="folder">{row.folder}</span>}
          {row.folder && row.height > 0 && <span className="sep" />}
          {row.height > 0 && <span>{resolutionLabel(row.height)}</span>}
          {row.rating > 0 && <Rating value={row.rating} compact />}
        </div>
        <SearchMatch match={row.searchMatch} />
      </div>
    </div>
  )
})

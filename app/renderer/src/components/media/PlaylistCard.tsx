import { ListVideo } from 'lucide-react'
import { memo, type KeyboardEvent } from 'react'
import type { PlaylistEntry } from '@shared/library'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { ThumbnailImage } from './ThumbnailImage'
import './PlaylistCard.css'

interface Props {
  entry: PlaylistEntry
  density?: 'comfortable' | 'compact'
  onOpen: (id: number) => void
}

const open = (entry: PlaylistEntry, onOpen: (id: number) => void) => onOpen(entry.id)

const onKey = (entry: PlaylistEntry, onOpen: (id: number) => void) => (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    open(entry, onOpen)
  }
}

function Mosaic({ thumbs }: { thumbs: string[] }) {
  return (
    <div className={`plmos n${thumbs.length}`}>
      {thumbs.map((thumb) => (
        <ThumbnailImage key={thumb} src={thumb} alt="" draggable={false} loading="lazy" decoding="async" />
      ))}
    </div>
  )
}

export const PlaylistCard = memo(function PlaylistCard({ entry, density = 'comfortable', onOpen }: Props) {
  const t = useT()
  return (
    <div
      className={cx('card', 'plcard', `card-${density}`)}
      tabIndex={0}
      role="option"
      aria-selected={false}
      data-playlist-id={entry.id}
      onClick={() => open(entry, onOpen)}
      onDoubleClick={() => open(entry, onOpen)}
      onKeyDown={onKey(entry, onOpen)}
    >
      <div className="thumb">
        <Mosaic thumbs={entry.thumbs} />
        <div className="tl">
          <span className="badge-pl">
            <ListVideo />
            {t('library.playlist.label')}
          </span>
        </div>
      </div>
      <div className="text">
        <div className="title" title={entry.name}>
          {entry.name}
        </div>
        <div className="meta">
          <span>{t('library.videos', { count: entry.count })}</span>
        </div>
      </div>
    </div>
  )
})

export const PlaylistRow = memo(function PlaylistRow({ entry, condensed = false, onOpen }: Props & { condensed?: boolean }) {
  const t = useT()
  return (
    <div
      className={cx('mrow', 'plrow', condensed && 'mrow-c')}
      tabIndex={0}
      role="option"
      aria-selected={false}
      data-playlist-id={entry.id}
      onClick={() => open(entry, onOpen)}
      onDoubleClick={() => open(entry, onOpen)}
      onKeyDown={onKey(entry, onOpen)}
    >
      <div className="thumb">
        <Mosaic thumbs={entry.thumbs} />
      </div>
      {condensed ? (
        <>
          <div className="title" title={entry.name}>
            <ListVideo />
            {entry.name}
          </div>
          <span className="ax">{t('media.playlistVideos', { count: entry.count })}</span>
        </>
      ) : (
        <>
          <div className="mrow-main">
            <div className="title" title={entry.name}>
              <ListVideo />
              {entry.name}
            </div>
            <div className="meta">
              <span>{t('library.playlist.label')}</span>
            </div>
          </div>
          <div className="mrow-side">
            <span className="d">{t('library.videos', { count: entry.count })}</span>
          </div>
        </>
      )}
    </div>
  )
})

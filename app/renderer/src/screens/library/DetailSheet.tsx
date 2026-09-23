import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Ellipsis, ExternalLink, ListPlus, Play, Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AXIS_LABEL, AXIS_NAME, isAxisId } from '@shared/axes'
import { PROJECTION_LABELS } from '@shared/projection'
import { AxisChips } from '@/components/media/AxisChips'
import { FavButton } from '@/components/media/FavButton'
import { ThumbnailImage } from '@/components/media/ThumbnailImage'
import { HeatStrip } from '@/components/media/HeatStrip'
import { resolutionLabel } from '@/components/media/MediaCard'
import { Rating } from '@/components/media/Rating'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { fmtDuration, fmtSpeed } from '@/lib/format'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useVideoSettings } from '@/state/settings'
import { openMediaMenu, renameMedia } from './MediaMenu'


export function DetailSheet() {
  const t = useT()
  const detail = useLibrary((s) => s.detail)
  const selectedId = useLibrary((s) => s.selectedId)
  const select = useLibrary((s) => s.select)
  const setRating = useLibrary((s) => s.setRating)
  const setTags = useLibrary((s) => s.setTags)
  const openTag = useLibrary((s) => s.openTag)
  const tags = useLibrary((s) => s.tags)
  const playlists = useLibrary((s) => s.playlists)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const open = usePlayer((s) => s.openLibraryMedia)
  const video = useVideoSettings(detail?.path ?? null)
  const [tagging, setTagging] = useState(false)
  const [tag, setTag] = useState('')
  if (selectedId === null) return null

  const submitTag = (e: FormEvent) => {
    e.preventDefault()
    const next = tag.trim().toLowerCase()
    if (!next) return setTagging(false)
    if (detail && !detail.tags.includes(next)) void setTags(detail.id, [...detail.tags, next])
    setTag('')
  }
  const watched = detail && detail.watchedMs !== null && detail.durationMs > 0 ? detail.watchedMs / detail.durationMs : null
  const facts = detail
    ? [
        fmtDuration(detail.durationMs),
        resolutionLabel(detail.height),
        detail.projection !== 'flat' ? t(PROJECTION_LABELS[detail.projection]) : null,
        detail.codec.toUpperCase(),
        t('library.detail.added', { date: new Date(detail.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }),
      ].filter((f): f is string => Boolean(f))
    : []
  const l0 = video?.axes.L0

  return (
    <aside className="lib-sheet" aria-label={t('library.detail.title')}>
      <div className="hero">
        {detail?.thumb && <ThumbnailImage src={detail.thumb} alt="" draggable={false} />}
        {detail && <div className="tl"><AxisChips axes={detail.axes} /></div>}
        <div className="hero-tr">
          {detail && <FavButton id={detail.id} favourite={detail.favourite} />}
          <IconButton label={t('common.close')} size="sm" onClick={() => void select(null)}>
            <X />
          </IconButton>
        </div>
        {watched !== null && (
          <div className="prog">
            <i style={{ width: `${Math.min(1, watched) * 100}%` }} />
          </div>
        )}
      </div>
      {detail && (
        <div className="body">
          <div>
            <h2 onDoubleClick={() => renameMedia(detail)}>{detail.title}</h2>
            <div className="path" title={detail.path}>
              {detail.path}
            </div>
          </div>
          <div className="facts">
            {facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
          <div className="tags">
            {detail.tags.map((name) => (
              <span key={name} className="chip">
                <button type="button" onClick={() => openTag(name)}>
                  {name}
                </button>
                <button type="button" className="x" aria-label={t('library.detail.removeTag', { name })} title={t('common.remove')} onClick={() => void setTags(detail.id, detail.tags.filter((x) => x !== name))}>
                  <X />
                </button>
              </span>
            ))}
            {tagging ? (
              <form onSubmit={submitTag}>
                <input
                  autoFocus
                  className="input tag-input"
                  placeholder={t('library.tag.placeholder')}
                  aria-label={t('library.tag.new')}
                  list="sheet-tags"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  onBlur={() => setTagging(false)}
                  onKeyDown={(e) => e.key === 'Escape' && setTagging(false)}
                />
                <datalist id="sheet-tags">
                  {tags
                    .filter((row) => !detail.tags.includes(row.name))
                    .map((row) => (
                      <option key={row.name} value={row.name} />
                    ))}
                </datalist>
              </form>
            ) : (
              <button type="button" className="chip add" aria-label={t('library.tag.add')} title={t('library.tag.add')} onClick={() => setTagging(true)}>
                <Plus />
              </button>
            )}
          </div>
          <div className="actions">
            <Button variant="primary" className="primary" onClick={() => void open(detail)}>
              <Play />
              {t('common.play')}
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button disabled={playlists.length === 0}>
                  <ListPlus />
                  {t('library.playlist.label')}
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                  {playlists.map((p) => (
                    <DropdownMenu.Item key={p.id} className="item" onSelect={() => void addToPlaylist(p.id, [detail.id])}>
                      {p.name}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Button icon aria-label={t('common.more')} aria-haspopup="menu" onClick={(event) => openMediaMenu(detail, event)}>
              <Ellipsis />
            </Button>
          </div>
          <div className="sec">
            <div className="hd">
              <span className="eyebrow">{detail.scripts.length === 0 ? t('media.noScript') : t('library.detail.scriptAxes', { count: detail.scripts.length })}</span>
              {detail.scripts[0] && <span className="faint mono small">{detail.scripts[0].container}</span>}
            </div>
            {detail.scripts.map((s) => (
              <div key={s.axis} className="axrow">
                <span className="axis">{isAxisId(s.axis) ? AXIS_LABEL[s.axis] : s.axis}</span>
                <span className="name">{isAxisId(s.axis) ? t(AXIS_NAME[s.axis]) : s.axis}</span>
                <HeatStrip heat={s.heatmap} className="axheat" />
                <span className="spd">{fmtSpeed(s.averageSpeed)}</span>
              </div>
            ))}
          </div>
          <div className="sec">
            <div className="hd">
              <span className="eyebrow">{t('library.sort.rating')}</span>
              <Rating value={detail.rating} onChange={(r) => void setRating(detail.id, r)} />
            </div>
          </div>
          <div className="sec">
            <div className="hd">
              <span className="eyebrow">{t('library.detail.settings')}</span>
              <button type="button" className="link" onClick={() => void open(detail)}>
                <ExternalLink />
                {t('library.detail.editInPlayer')}
              </button>
            </div>
            <div className="kv">
              <span className="k">{t('library.detail.offset')}</span>
              <span className="v">{video?.globalOffsetMs ? t('library.detail.ms', { value: `${video.globalOffsetMs > 0 ? '+' : ''}${video.globalOffsetMs}` }) : t('library.detail.default')}</span>
              <span className="k">{t('library.detail.strokeRange')}</span>
              <span className="v">{l0 ? t('library.detail.range', { min: Math.round(l0.min * 100), max: Math.round(l0.max * 100) }) : t('library.detail.default')}</span>
              <span className="k">{t('library.sort.lastPlayed')}</span>
              <span className="v">{detail.lastPlayed ? `${new Date(detail.lastPlayed).toLocaleDateString(undefined, { weekday: 'short' })}${watched !== null ? ` · ${Math.round(watched * 100)}%` : ''}` : t('library.detail.never')}</span>
              <span className="k">{t('library.detail.plays')}</span>
              <span className="v">{detail.playCount}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

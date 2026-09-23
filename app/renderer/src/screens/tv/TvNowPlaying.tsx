import { Pause, Play, SkipBack, SkipForward, SlidersHorizontal, Square } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AxisChips } from '@/components/media/AxisChips'
import { MediaCard } from '@/components/media/MediaCard'
import { Recompute } from '@/components/player/Recompute'
import { VideoSlot } from '@/components/player/VideoSlot'
import { resolutionLabel } from '@/components/media/MediaCard'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { useActiveAxes, usePlayer } from '@/state/player'
import { useSession } from '@/state/session'
import { useUi } from '@/state/ui'

const HIDE_AFTER_MS = 4000
const STRIP_FRAMES = 20
const SEEK_S = 10
const SEEK_HELD_S = 60
const HOLD_AFTER = 5
const PREVIEW_MS = 800

export function TvStage() {
  return (
    <div className="tv-stage">
      <VideoSlot subtitles />
      <Recompute />
    </div>
  )
}

export function TvNowPlaying() {
  const t = useT()
  const title = usePlayer((s) => s.title)
  const projection = usePlayer((s) => s.projection)
  const paused = usePlayer((s) => s.snapshot.paused)
  const durationMs = usePlayer((s) => s.snapshot.durationMs)
  const vh = usePlayer((s) => s.snapshot.videoHeight)
  const strip = usePlayer((s) => s.media?.strip ?? null)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const seekBy = usePlayer((s) => s.seekBy)
  const seek = usePlayer((s) => s.seek)
  const close = usePlayer((s) => s.close)
  const setTvTab = useUi((s) => s.setTvTab)
  const setTvOverlay = useUi((s) => s.setTvOverlay)
  const activeAxes = useActiveAxes()
  const stage = useSession((s) => s.stage)
  const revealed = useSession((s) => s.revealed)
  const showTimes = useSession((s) => s.setup.showTimes)
  const plan = useSession((s) => s.plan)
  const index = useSession((s) => s.index)
  const next = useSession((s) => s.next)
  const previous = useSession((s) => s.previous)
  const [shown, setShown] = useState(true)
  const shownRef = useRef(true)
  const timer = useRef(0)
  const fill = useRef<HTMLElement>(null)
  const elapsed = useRef<HTMLSpanElement>(null)
  const inSession = stage === 'running'
  const [preview, setPreview] = useState<number | null>(null)
  const previewTimer = useRef(0)
  const repeats = useRef(0)

  useEffect(() => {
    const wake = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        shownRef.current = false
        setShown(false)
      }, HIDE_AFTER_MS)
      if (!shownRef.current) {
        shownRef.current = true
        setShown(true)
      }
    }
    wake()
    window.addEventListener('keydown', wake)
    window.addEventListener('pointermove', wake)
    return () => {
      window.clearTimeout(timer.current)
      window.removeEventListener('keydown', wake)
      window.removeEventListener('pointermove', wake)
    }
  }, [])

  useEffect(() => {
    document.querySelector<HTMLElement>('.tv')?.setAttribute('data-chrome', shown || paused ? 'shown' : 'hidden')
    return () => document.querySelector<HTMLElement>('.tv')?.removeAttribute('data-chrome')
  }, [shown, paused])

  live.useLive((l) => {
    if (fill.current) fill.current.style.transform = `scaleX(${l.durationMs > 0 ? Math.min(1, l.timeMs / l.durationMs) : 0})`
    const text = fmtDuration(l.timeMs)
    if (elapsed.current && elapsed.current.textContent !== text) elapsed.current.textContent = text
  }, [])

  useEffect(() => () => window.clearTimeout(previewTimer.current), [])

  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    repeats.current = e.repeat ? repeats.current + 1 : 0
    const step = (repeats.current >= HOLD_AFTER ? SEEK_HELD_S : SEEK_S) * (e.key === 'ArrowRight' ? 1 : -1)
    const target = Math.max(0, Math.min(durationMs, (preview ?? live.get().timeMs) + step * 1000))
    setPreview(target)
    seek(target / 1000)
    window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => setPreview(null), PREVIEW_MS)
  }

  const stop = () => {
    close()
    setTvTab('library')
  }

  const upNext = inSession && revealed ? plan.slice(index + 1, index + 6) : []
  const previewFraction = preview !== null && durationMs > 0 ? preview / durationMs : 0

  return (
    <>
      <div className="np" data-nav-main>
        <span className="eyebrow">{inSession ? (showTimes ? t('tv.nowPlaying.sessionClip', { index: index + 1, total: plan.length }) : t('screen.session')) : t('screen.player')}</span>
        <h1>{title}</h1>
        <div className="meta">
          <AxisChips axes={activeAxes} />
          <span>{[projection.kind !== 'flat' ? t('tv.nowPlaying.vr') : null, resolutionLabel(vh) || null, fmtDuration(durationMs)].filter(Boolean).join(' · ')}</span>
        </div>
        <div>
          <div className="bar" tabIndex={0} role="slider" aria-label={t('tv.nowPlaying.position')} aria-valuemin={0} aria-valuemax={Math.round(durationMs / 1000)} data-nav-horizontal onKeyDown={onBarKey}>
            <i ref={fill} style={{ width: '100%', transformOrigin: 'left' }} />
            {preview !== null && (
              <div className="preview" style={{ left: `${(previewFraction * 100).toFixed(3)}%` }}>
                {strip && <div className="pt" style={{ backgroundImage: `url(${strip})`, backgroundPositionX: `${(Math.min(STRIP_FRAMES - 1, Math.floor(previewFraction * STRIP_FRAMES)) / (STRIP_FRAMES - 1)) * 100}%` }} />}
                <span className="pl">{fmtDuration(preview)}</span>
              </div>
            )}
          </div>
          <div className="times">
            <span ref={elapsed}>{fmtDuration(live.get().timeMs)}</span>
            <span>{fmtDuration(durationMs)}</span>
          </div>
        </div>
        <div className="ctl">
          <button type="button" aria-label={inSession ? t('tv.nowPlaying.previousClip') : t('tv.nowPlaying.back10')} onClick={() => (inSession ? previous() : seekBy(-10))}>
            <SkipBack />
          </button>
          <button type="button" data-nav-first aria-label={paused ? t('common.play') : t('common.pause')} onClick={togglePlay}>
            {paused ? <Play /> : <Pause />}
          </button>
          <button type="button" aria-label={inSession ? t('tv.nowPlaying.nextClip') : t('tv.nowPlaying.forward10')} onClick={() => (inSession ? next() : seekBy(10))}>
            <SkipForward />
          </button>
          <button type="button" aria-label={t('tv.quickSettings.title')} onClick={() => setTvOverlay('quick')}>
            <SlidersHorizontal />
          </button>
          <button type="button" aria-label={t('common.stop')} onClick={stop}>
            <Square />
          </button>
        </div>
      </div>
      {upNext.length > 0 && (
        <div className="upnext">
          <span className="eyebrow">{t('tv.nowPlaying.upNext')}</span>
          <div className="tv-row">
            {upNext.map((c, i) => (
              <MediaCard key={`${c.row.id}:${i}`} row={c.row} density="tenfoot" onSelect={() => undefined} onPlay={() => next()} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

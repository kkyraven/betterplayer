import { ListVideo, Maximize2, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { VideoSlot } from '@/components/player/VideoSlot'
import { phaseTone } from '@/components/session/PhaseStrip'
import { IconButton } from '@/components/ui/IconButton'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { invoke, on } from '@/ipc'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { Scrubber } from '@/screens/player/Scrubber'
import { TimeText } from '@/screens/player/ControlBar'
import { intensityAt, phaseAt } from '@/session/pacing'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { usePlayer, type PlaylistPlayback } from '@/state/player'
import { sessionElapsedMs, useSession } from '@/state/session'
import { useUi } from '@/state/ui'

export function NowPlayingStrip() {
  const path = usePlayer((s) => s.path)
  const hiddenFor = useUi((s) => s.stripHiddenFor)
  if (path === null || path === hiddenFor) return null
  return (
    <TooltipGroup className="nowplaying">
      <StripContent />
    </TooltipGroup>
  )
}

function StripContent() {
  const t = useT()
  const title = usePlayer((s) => s.title)
  const durationMs = usePlayer((s) => s.snapshot.durationMs)
  const paused = usePlayer((s) => s.snapshot.paused)
  const scripts = usePlayer((s) => s.scripts)
  const strip = usePlayer((s) => s.media?.strip ?? null)
  const playlist = usePlayer((s) => s.playlist)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const seek = usePlayer((s) => s.seek)
  const step = usePlayer((s) => s.step)
  const path = usePlayer((s) => s.path)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const setScreen = useUi((s) => s.setScreen)
  const hideStrip = useUi((s) => s.hideStrip)
  const inSession = useSession((s) => s.stage === 'running')
  const nextClip = useSession((s) => s.next)
  const previousClip = useSession((s) => s.previous)
  const clip = useSession((s) => (s.stage === 'running' ? s.plan[s.index] : undefined))
  const showTimes = useSession((s) => s.setup.showTimes)
  const openPlayer = () => setScreen('player')

  const stroke = scripts.find((s) => s.axis === 'L0' && s.selected) ?? scripts.find((s) => s.selected) ?? scripts[0]
  const chapters = useMemo(() => scripts.filter((s) => s.selected).flatMap((s) => s.chapters), [scripts])
  const bookmarks = useMemo(() => scripts.filter((s) => s.selected).flatMap((s) => s.bookmarks), [scripts])

  return (
    <>
      <div className="np-video" onClick={openPlayer} title={t('app.nowPlaying.openPlayer')}>
        <VideoSlot compact />
        <span className="np-open" aria-hidden>
          <Maximize2 />
        </span>
      </div>
      <div className="np-ctl">
        <IconButton label={inSession ? t('player.controls.previousClip') : t('app.nowPlaying.previous')} size="sm" onClick={() => (inSession ? previousClip() : void step(-1))}>
          <SkipBack />
        </IconButton>
        <IconButton label={t(paused ? 'common.play' : 'common.pause')} size="lg" onClick={togglePlay}>
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton label={inSession ? t('player.controls.nextClip') : t('app.nowPlaying.next')} size="sm" onClick={() => (inSession ? nextClip() : void step(1))}>
          <SkipForward />
        </IconButton>
      </div>
      <div className="np-mid">
        <div className="np-top">
          <button type="button" className="np-title" onClick={openPlayer} title={t('app.nowPlaying.openPlayer')}>
            {title}
          </button>
          {inSession ? <SessionLine /> : <NextUp playlist={playlist} />}
          {(!inSession || showTimes) && <TimeText durationMs={durationMs} clip={clip} />}
        </div>
        <Scrubber durationMs={durationMs} heatmap={stroke?.heatmap ?? []} heatDurationMs={stroke?.durationMs ?? 0} chapters={chapters} bookmarks={bookmarks} strip={strip} onSeek={(ms) => seek(ms / 1000)} />
      </div>
      <div className="np-right">
        {inSession && <PhasePill />}
        <IconButton label={muted ? t('player.controls.unmute') : t('player.controls.mute')} size="sm" onClick={toggleMute}>
          {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <input className="vol" type="range" min={0} max={100} value={muted ? 0 : Math.round(volume * 100)} aria-label={t('player.controls.volume')} onChange={(e) => setVolume(Number(e.target.value) / 100)} />
        <span className="vsep" />
        <IconButton label={t('app.nowPlaying.openPlayer')} size="sm" className="np-faint" onClick={openPlayer}>
          <Maximize2 />
        </IconButton>
        <IconButton label={t('common.hide')} size="sm" className="np-faint" onClick={() => path && hideStrip(path)}>
          <X />
        </IconButton>
      </div>
    </>
  )
}

function NextUp({ playlist }: { playlist: PlaylistPlayback | null }) {
  const t = useT()
  const nextId = playlist?.ids[playlist.index + 1]
  const [next, setNext] = useState<string | null>(null)
  useEffect(() => {
    if (nextId === undefined) {
      setNext(null)
      return
    }
    let current = true
    const refresh = () => void invoke('library:media', nextId).then((m) => current && setNext(m?.title ?? null))
    refresh()
    const unsubscribe = on('library:changed', (change) => {
      if (change.kind === 'meta') refresh()
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [nextId])
  if (!playlist) return null
  return (
    <span className="np-sub">
      <ListVideo />
      {next && (
        <span className="np-next">
          {t('app.nowPlaying.nextUp')} <b>{next}</b> ·
        </span>
      )}
      <span>{t('app.nowPlaying.queuePosition', { position: playlist.index + 1, total: playlist.ids.length })}</span>
    </span>
  )
}

function SessionLine() {
  const t = useT()
  const index = useSession((s) => s.index)
  const total = useSession((s) => s.plan.length)
  return (
    <span className="np-sub">
      <Shuffle />
      <span>{t('tv.nowPlaying.sessionClip', { index: index + 1, total })}</span>
    </span>
  )
}

function PhasePill() {
  const t = useT()
  const phases = useSession((s) => s.phases)
  const plan = useSession((s) => s.plan)
  const index = useSession((s) => s.index)
  const showTimes = useSession((s) => s.setup.showTimes)
  const read = (timeMs: number) => {
    const elapsed = sessionElapsedMs(plan, index, timeMs)
    const phase = phases[phaseAt(phases, elapsed)]
    return `${phase?.label ?? ''}|${phaseTone(intensityAt(phases, elapsed))}|${fmtDuration(Math.max(0, (phase?.endMs ?? 0) - elapsed))}`
  }
  const [text, setText] = useState(() => read(live.get().timeMs))
  live.useLive((l) => setText(read(l.timeMs)), [plan, index, phases])
  const [label, tone, left] = text.split('|')
  return (
    <>
      <span className={cx('phase-pill', `tone-${tone}`)}>{label}</span>
      {showTimes && <span className="np-left">{t('player.sessionStrip.left', { time: left ?? '' })}</span>}
    </>
  )
}

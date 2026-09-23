import { Captions, CaptionsOff, Crosshair, Glasses, List, ListVideo, Maximize2, Minimize2, Pause, Play, Repeat, Repeat1, Rewind, FastForward, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { IconButton } from '@/components/ui/IconButton'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { RATES, usePlayer } from '@/state/player'
import { useRemote } from '@/state/remote'
import { useSession } from '@/state/session'
import { useSettings } from '@/state/settings'
import { useSubtitles } from '@/state/subtitles'
import { useTracking } from '@/state/tracking'
import { useUi } from '@/state/ui'
import { Scrubber } from './Scrubber'
import { SessionStrip } from './SessionStrip'
import { VariantMenu, variantGroups } from './VariantMenu'

export function ControlBar({ overlay, onHoverChange }: { overlay: HTMLDivElement | null; onHoverChange: (hovered: boolean) => void }) {
  const t = useT()
  const paused = usePlayer((s) => s.snapshot.paused)
  const ownRate = usePlayer((s) => s.snapshot.rate)
  const followedRate = useRemote((s) => (s.followed ? s.playing.rate : null))
  const baseRate = useTracking((s) => s.playbackBaseRate)
  const rate = followedRate ?? baseRate ?? ownRate
  const durationMs = usePlayer((s) => s.snapshot.durationMs)
  const scripts = usePlayer((s) => s.scripts)
  const strip = usePlayer((s) => s.media?.strip ?? null)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const seek = usePlayer((s) => s.seek)
  const seekBy = usePlayer((s) => s.seekBy)
  const step = usePlayer((s) => s.step)
  const setRate = usePlayer((s) => s.setRate)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const autoplay = usePlayer((s) => s.autoplay)
  const repeat = usePlayer((s) => s.repeat)
  const cycleAutoplay = usePlayer((s) => s.cycleAutoplay)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const sheet = usePlayer((s) => s.sheet)
  const setSheet = usePlayer((s) => s.setSheet)
  const fullscreen = useUi((s) => s.fullscreen)
  const toggleFullscreen = useUi((s) => s.toggleFullscreen)
  const inSession = useSession((s) => s.stage === 'running')
  const hasQueue = usePlayer((s) => s.playlist !== null)
  const trackSource = useTracking((s) => s.source)
  const startTracking = useTracking((s) => s.start)
  const stopTracking = useTracking((s) => s.stop)
  const nextClip = useSession((s) => s.next)
  const previousClip = useSession((s) => s.previous)
  const clip = useSession((s) => (s.stage === 'running' ? s.plan[s.index] : undefined))
  const showTimes = useSession((s) => s.setup.showTimes)
  const hasSubtitles = useSubtitles((s) => s.tracks.length > 0)
  const subtitlesOn = useSettings((s) => s.settings?.subtitles.enabled) ?? true
  const updateSettings = useSettings((s) => s.update)
  const toggleSubtitles = () => void updateSettings((s) => ({ ...s, subtitles: { ...s.subtitles, enabled: !s.subtitles.enabled } }))

  const stroke = scripts.find((s) => s.axis === 'L0' && s.selected) ?? scripts.find((s) => s.selected) ?? scripts[0]
  const chapters = useMemo(() => scripts.filter((s) => s.selected).flatMap((s) => s.chapters), [scripts])
  const bookmarks = useMemo(() => scripts.filter((s) => s.selected).flatMap((s) => s.bookmarks), [scripts])
  const variants = useMemo(() => variantGroups(scripts), [scripts])
  const nextRate = () => {
    const i = RATES.findIndex((r) => r >= rate - 0.001)
    setRate(RATES[(i + 1) % RATES.length] ?? 1)
  }

  return (
    <TooltipGroup onHoverChange={onHoverChange} className="bar" onPointerDown={(e) => e.stopPropagation()}>
      {inSession && <SessionStrip />}
      <div className="row">
        <div className="ctl-row">
          <IconButton label={inSession ? t('player.controls.previousClip') : t('player.controls.previousVideo')} onClick={() => (inSession ? previousClip() : void step(-1))}>
            <SkipBack />
          </IconButton>
          <IconButton label={t('player.controls.back10')} onClick={() => seekBy(-10)}>
            <Rewind />
          </IconButton>
          <IconButton label={paused ? t('player.controls.play') : t('player.controls.pause')} size="lg" onClick={togglePlay}>
            {paused ? <Play /> : <Pause />}
          </IconButton>
          <IconButton label={t('player.controls.forward10')} onClick={() => seekBy(10)}>
            <FastForward />
          </IconButton>
          <IconButton label={inSession ? t('player.controls.nextClip') : t('player.controls.nextVideo')} onClick={() => (inSession ? nextClip() : void step(1))}>
            <SkipForward />
          </IconButton>
          <span className="vsep" />
          {(!inSession || showTimes) && <TimeText durationMs={durationMs} clip={clip} />}
        </div>
        <div className="center" />
        <div className="ctl-row">
          <IconButton label={muted ? t('player.controls.unmute') : t('player.controls.mute')} onClick={toggleMute}>
            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <input
            className="vol"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            aria-label={t('player.controls.volume')}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
          />
          <button type="button" className="rate" onClick={nextRate} aria-label={t('player.controls.speed')}>
            {rate}×
          </button>
          {variants.length > 0 && <VariantMenu groups={variants} overlay={overlay} />}
          <IconButton label={t(`player.controls.autoplay.${autoplay}`)} className={autoplay !== 'off' ? 'on' : undefined} onClick={cycleAutoplay}>
            {autoplay === 'random' ? <Shuffle /> : <ListVideo />}
          </IconButton>
          <IconButton label={t(`player.controls.repeat.${repeat}`)} className={repeat !== 'off' ? 'on' : undefined} onClick={cycleRepeat}>
            {repeat === 'once' ? <Repeat1 /> : <Repeat />}
          </IconButton>
          {hasQueue && !inSession && (
            <IconButton id="queue-toggle" label={t('player.queue.title')} aria-expanded={sheet === 'queue'} aria-controls={sheet === 'queue' ? 'player-queue' : undefined} className={sheet === 'queue' ? 'on' : undefined} onClick={() => setSheet(sheet === 'queue' ? null : 'queue')}>
              <List />
            </IconButton>
          )}
          {hasSubtitles && (
            <IconButton label={subtitlesOn ? t('player.controls.hideSubtitles') : t('player.controls.showSubtitles')} className={subtitlesOn ? 'on' : undefined} onClick={toggleSubtitles}>
              {subtitlesOn ? <Captions /> : <CaptionsOff />}
            </IconButton>
          )}
          <span className="vsep" />
          <IconButton label={trackSource === 'player' ? t('player.controls.stopTracking') : t('player.controls.trackMotion')} className={trackSource === 'player' ? 'on' : undefined} onClick={() => (trackSource === 'player' ? stopTracking() : startTracking('player'))}>
            <Crosshair />
          </IconButton>
          <IconButton label={t('player.controls.videoSettings')} className={sheet && sheet !== 'queue' ? 'on' : undefined} onClick={() => setSheet(sheet && sheet !== 'queue' ? null : 'video')}>
            <SlidersHorizontal />
          </IconButton>
          <IconButton label={t('player.sideSheet.projection')} className={sheet === 'projection' ? 'on' : undefined} onClick={() => setSheet('projection')}>
            <Glasses />
          </IconButton>
          <IconButton label={fullscreen ? t('player.controls.exitFullscreen') : t('player.controls.fullscreen')} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </div>
      </div>
      <Scrubber durationMs={durationMs} heatmap={stroke?.heatmap ?? []} heatDurationMs={stroke?.durationMs ?? 0} chapters={chapters} bookmarks={bookmarks} strip={strip} onSeek={(ms) => seek(ms / 1000)} />
    </TooltipGroup>
  )
}

export function TimeText({ durationMs, clip }: { durationMs: number; clip: { startMs: number; endMs: number } | undefined }) {
  const elapsed = useRef<HTMLSpanElement>(null)
  const startMs = clip?.startMs ?? 0
  live.useLive(
    (l) => {
      const text = fmtDuration(Math.max(0, l.timeMs - startMs))
      if (elapsed.current && elapsed.current.textContent !== text) elapsed.current.textContent = text
    },
    [startMs],
  )
  return (
    <span className="time">
      <span ref={elapsed}>{fmtDuration(Math.max(0, live.get().timeMs - startMs))}</span> <span className="t3">/ {fmtDuration(clip ? clip.endMs - clip.startMs : durationMs)}</span>
    </span>
  )
}

import { ChevronLeft } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { IconButton } from '@/components/ui/IconButton'
import { DeviceViz } from '@/components/player/DeviceViz'
import { Recompute } from '@/components/player/Recompute'
import { VideoSlot } from '@/components/player/VideoSlot'
import { HeroTip } from '@/components/tracking/HeroTip'
import { RegionBox, ZoneBox, ZoneBoxes } from '@/components/tracking/RegionBox'
import { UPSCALER_LABELS } from '@shared/settings'
import { useCompare } from '@/state/compare'
import { useT } from '@/state/i18n'
import { TrackBar } from '@/components/tracking/TrackBar'
import { isUrl, usePlayer } from '@/state/player'
import { useSession } from '@/state/session'
import { useTracking } from '@/state/tracking'
import { SCREEN_LABEL, useUi } from '@/state/ui'
import { ControlBar } from './ControlBar'
import { SideSheet } from './SideSheet'
import './player.css'

const HIDE_AFTER_MS = 2000

export function PlayerScreen() {
  const t = useT()
  const path = usePlayer((s) => s.path)
  const loadError = usePlayer((s) => s.snapshot.error)
  const title = usePlayer((s) => s.title)
  const audio = usePlayer((s) => s.audio)
  const paused = usePlayer((s) => s.snapshot.paused)
  const sheet = usePlayer((s) => s.sheet)
  const setScreen = useUi((s) => s.setScreen)
  const back = useUi((s) => s.previous)
  const toggleFullscreen = useUi((s) => s.toggleFullscreen)
  const sessionTitle = useSession((s) => (s.stage !== 'running' ? null : s.setup.showTimes ? t('player.sessionStrip.clipOf', { index: s.index + 1, total: s.plan.length }) : t('player.sessionStrip.title')))
  const heading = sessionTitle ?? (audio ? null : title)
  const zoneEdit = useTracking((s) => s.zoneEdit)
  const comparing = useCompare((s) => s.on)
  const compareLeft = useCompare((s) => s.left)
  const compareRight = useCompare((s) => s.right)
  const [topHovered, setTopHovered] = useState(false)
  const [barHovered, setBarHovered] = useState(false)
  const [shown, setShown] = useState(true)
  const shownRef = useRef(true)
  const hideTimer = useRef(0)
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null)

  const wake = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      shownRef.current = false
      setShown(false)
    }, HIDE_AFTER_MS)
    if (!shownRef.current) {
      shownRef.current = true
      setShown(true)
    }
  }, [])
  useEffect(() => {
    wake()
    return () => window.clearTimeout(hideTimer.current)
  }, [wake])
  const chrome = zoneEdit ? 'zone' : !path || shown || topHovered || barHovered || paused || sheet !== null ? 'shown' : 'hidden'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const t = useTracking.getState()
      if (t.zoneEdit) {
        if (e.key === 'Escape' || e.key === 'Enter') {
          t.setZoneEdit(false)
          e.preventDefault()
        }
        return
      }
      if (e.key === 'Escape') {
        const p = usePlayer.getState()
        const u = useUi.getState()
        if (p.sheet) p.setSheet(null)
        else if (!u.fullscreen && !u.mediaCentre) u.setScreen(u.previous)
        e.preventDefault()
      }
      wake()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wake])

  useEffect(() => {
    const t = window.setInterval(() => usePlayer.getState().savePosition(), 5000)
    return () => {
      window.clearInterval(t)
      usePlayer.getState().savePosition()
    }
  }, [])

  return (
    <div className="stage" data-empty={!path || undefined} data-chrome={chrome} onPointerMove={wake} onPointerDown={wake}>
      {path && <VideoSlot subtitles onClick={() => {
        if (!useTracking.getState().zoneEdit && usePlayer.getState().snapshot.loaded) usePlayer.getState().togglePlay()
      }} onDoubleClick={() => void toggleFullscreen()} />}
      <RegionBox />
      <ZoneBox />
      <ZoneBoxes />
      <HeroTip />
      {!path && (
        <div className="pempty">
          <span className="faint">{t('player.empty.nothingPlaying')}</span>
          <Button onClick={() => setScreen('library')}>{t('player.empty.openLibrary')}</Button>
        </div>
      )}
      {path && loadError && (
        <div className="pnotice" role="alert">
          <b>{t('player.error.couldNotPlay')}</b>
          <span>{isUrl(path) ? t('player.error.ytdlp') : loadError}</span>
        </div>
      )}
      {path && (
        <div className="overlay" ref={setOverlay}>
          <Recompute />
          {comparing ? (
            <div className="scrim top compare">
              <span className="half">{t(UPSCALER_LABELS[compareLeft])}</span>
              <span className="half">{t(UPSCALER_LABELS[compareRight])}</span>
              <Button className="done" onClick={() => useCompare.getState().stop()}>{t('common.done')}</Button>
            </div>
          ) : (
          <TooltipGroup side="bottom" className="scrim top" onHoverChange={setTopHovered}>
            <div className="title-block">
              <IconButton label={t('player.controls.backTo', { screen: t(SCREEN_LABEL[back]) })} className="back" onClick={() => setScreen(back)}>
                <ChevronLeft />
              </IconButton>
              {heading && <h2 className={sessionTitle ? 'faint' : undefined}>{heading}</h2>}
            </div>
            <TrackBar variant="player" />
          </TooltipGroup>
          )}
          {!sheet && <DeviceViz />}
          <SideSheet />
          <ControlBar overlay={overlay} onHoverChange={setBarHovered} />
        </div>
      )}
    </div>
  )
}

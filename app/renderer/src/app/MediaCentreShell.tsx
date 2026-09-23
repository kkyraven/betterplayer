import { useEffect, useRef } from 'react'
import { SessionPanel } from '@/components/together/SessionPanel'
import { installGamepad } from '@/input/gamepad'
import { spaceIsClaimed } from '@/input/keyboard'
import { installSpatialNav, rememberFocus, restoreFocusWhenReady } from '@/input/spatialNav'
import { fmtDuration } from '@/lib/format'
import * as live from '@/state/live'
import { usePlayer } from '@/state/player'
import { useSession } from '@/state/session'
import { useTogether } from '@/state/together'
import { tvTabStep, type TvView } from '@/state/tvNav'
import { TvBackdrop } from '@/screens/tv/TvBackdrop'
import { TvBrowse } from '@/screens/tv/TvBrowse'
import { TvGrid } from '@/screens/tv/TvGrid'
import { TvHints, type HintContext } from '@/screens/tv/TvHints'
import { TvNowPlaying, TvStage } from '@/screens/tv/TvNowPlaying'
import { TvPowerMenu } from '@/screens/tv/TvPowerMenu'
import { TvQuickSettings } from '@/screens/tv/TvQuickSettings'
import { TvRows } from '@/screens/tv/TvRows'
import { TvSession } from '@/screens/tv/TvSession'
import { TvSettings } from '@/screens/tv/TvSettings'
import { TvTileOptions } from '@/screens/tv/TvTileOptions'
import { TvToast } from '@/screens/tv/TvToast'
import { TvTopBar } from '@/screens/tv/TvTopBar'
import { useUi } from '@/state/ui'
import './tv.css'

function viewKey(tab: string, views: TvView[]): string {
  if (tab === 'nowplaying') return tab
  return [tab, ...views.map((v) => (v.kind === 'browse' ? `browse:${v.what}` : v.kind === 'grid' ? `grid:${v.source.title}` : v.kind))].join('/')
}

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

export function MediaCentreShell() {
  const tab = useUi((s) => s.tvTab)
  const views = useUi((s) => s.tvViews)
  const overlay = useUi((s) => s.tvOverlay)
  const optionsRow = useUi((s) => s.tvOptionsRow)
  const setTvTab = useUi((s) => s.setTvTab)
  const path = usePlayer((s) => s.path)
  const incoming = useTogether((s) => s.session?.status === 'incoming')
  const container = useRef<HTMLDivElement>(null)
  const top = tab === 'nowplaying' ? undefined : views[views.length - 1]

  useEffect(() => {
    if (path && useUi.getState().tvTab === 'library') setTvTab('nowplaying')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = container.current
    if (!el) return
    let offNav = () => {}
    const attachNav = () => {
      const scope = incoming ? document.querySelector('.tg-invite')?.closest<HTMLElement>('[role="dialog"]') : el
      if (!scope) return
      offNav = installSpatialNav(scope)
      observer?.disconnect()
    }
    const observer = incoming ? new MutationObserver(attachNav) : null
    observer?.observe(document.body, { childList: true, subtree: true })
    attachNav()
    const offPad = installGamepad({
      seek: (s) => {
        if (incoming) return
        const ui = useUi.getState()
        if (ui.tvTab === 'nowplaying' && ui.tvOverlay === 'none') usePlayer.getState().seekBy(s)
      },
      power: () => {
        if (incoming) return
        const ui = useUi.getState()
        ui.setTvOverlay(ui.tvOverlay === 'power' ? 'none' : 'power')
      },
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceIsClaimed(e)) return
      if (incoming || e.defaultPrevented || isTyping(e) || (e.target instanceof Element && e.target.closest('.tg-panel'))) return
      const ui = useUi.getState()
      const player = usePlayer.getState()
      const playing = player.path !== null
      const atTop = ui.tvOverlay === 'none'
      switch (e.key) {
        case 'Escape':
        case 'Backspace':
          e.preventDefault()
          ui.tvBack(playing)
          return
        case ' ':
        case 'MediaPlayPause':
          if (!playing) return
          e.preventDefault()
          player.togglePlay()
          return
        case 'o':
        case 'O':
        case 'ContextMenu':
          if (ui.tvTab === 'nowplaying' && atTop) {
            e.preventDefault()
            ui.setTvOverlay('quick')
          }
          return
        case '[':
        case ']':
          if (ui.tvOverlay !== 'none') return
          e.preventDefault()
          setTvTab(tvTabStep(ui.tvTab, e.key === ']' ? 1 : -1, playing))
          return
        case 'MediaStop':
          if (!playing) return
          player.close()
          setTvTab('library')
          return
        case 'MediaTrackNext':
        case 'MediaTrackPrevious': {
          if (!playing) return
          const dir = e.key === 'MediaTrackNext' ? 1 : -1
          const session = useSession.getState()
          if (session.stage === 'running') (dir > 0 ? session.next : session.previous)()
          else player.seekBy(10 * dir)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      observer?.disconnect()
      offNav()
      offPad()
      window.removeEventListener('keydown', onKey)
    }
  }, [setTvTab, incoming])

  useEffect(() => {
    let key = viewKey(useUi.getState().tvTab, useUi.getState().tvViews)
    return useUi.subscribe((s) => {
      const el = container.current
      const next = viewKey(s.tvTab, s.tvViews)
      if (next === key || !el) return
      rememberFocus(key, el)
      key = next
    })
  }, [])
  const key = viewKey(tab, views)
  useEffect(() => {
    const el = container.current
    if (!el || incoming) return
    let stop = () => undefined as void
    const frame = requestAnimationFrame(() => {
      stop = restoreFocusWhenReady(key, el)
    })
    return () => {
      cancelAnimationFrame(frame)
      stop()
    }
  }, [key, incoming])

  const stage = tab === 'nowplaying' && !top
  const hint: HintContext = overlay !== 'none' ? 'overlay' : top?.kind === 'settings' ? 'settings' : top ? 'grid' : tab === 'nowplaying' ? 'nowplaying' : tab === 'session' ? 'session' : 'rows'

  return (
    <div ref={container} className="tv" data-tab={tab} data-stage={stage ? '' : undefined}>
      {stage && <TvStage />}
      {!stage && <TvBackdrop container={container} />}
      <TvTopBar />
      {top?.kind === 'settings' && <TvSettings />}
      {top?.kind === 'browse' && <TvBrowse what={top.what} />}
      {top?.kind === 'grid' && <TvGrid source={top.source} />}
      {!top && tab === 'nowplaying' && <TvNowPlaying />}
      {!top && tab === 'library' && <TvRows kind="library" />}
      {!top && tab === 'continue' && <TvRows kind="continue" />}
      {!top && tab === 'session' && <TvSession />}
      {!stage && path && <TvNowPlayingBar />}
      <TvHints context={hint} />
      <TvToast />
      {overlay === 'power' && <TvPowerMenu />}
      {overlay === 'quick' && <TvQuickSettings />}
      {overlay === 'options' && optionsRow && <TvTileOptions key={optionsRow.id} row={optionsRow} />}
      <SessionPanel />
    </div>
  )
}

function TvNowPlayingBar() {
  const title = usePlayer((s) => s.title)
  const durationMs = usePlayer((s) => s.snapshot.durationMs)
  const setTvTab = useUi((s) => s.setTvTab)
  const time = useRef<HTMLSpanElement>(null)
  const fill = useRef<HTMLElement>(null)
  live.useLive((l) => {
    const text = `${fmtDuration(l.timeMs)} / ${fmtDuration(durationMs)}`
    if (time.current && time.current.textContent !== text) time.current.textContent = text
    if (fill.current) fill.current.style.transform = `scaleX(${durationMs > 0 ? Math.min(1, l.timeMs / durationMs) : 0})`
  }, [durationMs])
  return (
    <button type="button" className="tv-np" data-focus-key="nowplayingbar" onClick={() => setTvTab('nowplaying')}>
      <div className="t">
        <div className="top">
          <span>{title}</span>
          <span ref={time} className="time" />
        </div>
        <div className="bar">
          <i ref={fill} style={{ width: '100%', transformOrigin: 'left' }} />
        </div>
      </div>
    </button>
  )
}

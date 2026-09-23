import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelState } from 'bp-engine'
import * as Popover from '@radix-ui/react-popover'
import { AlertTriangle, Download, Eye, Loader, MonitorPlay, Pause, Play, SlidersHorizontal, Volume2, Waves, Zap } from 'lucide-react'
import type { MessageKey } from '@shared/i18n'
import { REGION_TARGET_LABEL, REGION_TARGETS, describeEffect, paceFromSlider, paceToSlider, zoneName, type RegionTarget, type TrackSource as AxisSource } from '@shared/tracking'
import { INTIFACE_PORT_DEFAULT } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { invoke } from '@/ipc'
import { useBrowser } from '@/state/browser'
import { useDevices } from '@/state/devices'
import { useGenerate } from '@/state/generate'
import { useT } from '@/state/i18n'
import { intifaceStatusLine, useIntifaceEnabled, useIntifaceStatus } from '@/state/intiface'
import * as live from '@/state/live'
import { isUrl, usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { targetLabel, useTracking, type TrackSource } from '@/state/tracking'
import { AxesTable } from './AxesTable'
import { GenerateDialog } from './GenerateDialog'
import { HeroControls } from './HeroControls'
import { Advanced } from './Advanced'
import './TrackBar.css'

const STATE_LABEL: Record<string, MessageKey> = { idle: 'tracking.bar.state.idle', locating: 'tracking.bar.state.locating', tracking: 'tracking.bar.state.tracking' }
const SOURCES: ReadonlyArray<AxisSource> = ['video', 'ai-motion', 'beat', 'ai-music', 'hero', 'faptap']
const LOCATING_GRACE_MS = 5000

function useSlowLocating(locating: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!locating) {
      setSlow(false)
      return
    }
    const t = window.setTimeout(() => setSlow(true), LOCATING_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [locating])
  return slow
}

export function TrackBar({ variant }: { variant: TrackSource }) {
  const t = useT()
  const source = useTracking((s) => s.source)
  const st = useTracking((s) => s.state?.state ?? 'idle')
  const pos = useTracking((s) => Math.round((s.state?.position ?? 0.5) * 100))
  const sensitivity = useTracking((s) => s.sensitivity)
  const invert = useTracking((s) => s.axes.L0.invert)
  const stroke = useTracking((s) => s.axes.L0.source)
  const used = useTracking((s) => Object.values(s.axes).map((a) => a.source).join())
  const setSensitivity = useTracking((s) => s.setSensitivity)
  const setAxis = useTracking((s) => s.setAxis)
  const error = useBrowser((s) => s.error)
  const tab = useBrowser((s) => s.tabs.find((t) => t.active) ?? null)
  const pagePlaying = useBrowser((s) => s.tabs.find((t) => t.active)?.video?.playing ?? false)
  const local = usePlayer((s) => s.path !== null && !isUrl(s.path))
  const plan = useGenerate((s) => s.plan)
  const flagsVersion = usePlayer((s) => s.snapshot.flagsVersion)
  const scripted = useMemo(() => new Set(variant === 'player' ? live.axisIdsWith(live.FLAG_SCRIPT) : []), [variant, flagsVersion])
  const [axesOpen, setAxesOpen] = useState(false)
  const handoffRequest = useRef({ pending: false, disposed: false })
  useEffect(() => {
    handoffRequest.current.disposed = false
    return () => { handoffRequest.current.disposed = true }
  }, [])
  const slowLocating = useSlowLocating(st === 'locating')
  if (source !== variant) return null
  const browser = variant === 'browser'
  const drm = browser && error === 'drm'
  const showState = slowLocating || drm
  const uses = (src: AxisSource) => used.split(',').includes(src)
  const sections = SOURCES.filter(uses)
  const shared = (src: AxisSource, other: AxisSource) => uses(src) && uses(other) && sections.indexOf(src) > sections.indexOf(other)
  const playInPlayer = async () => {
    if (!tab || handoffRequest.current.pending) return
    handoffRequest.current.pending = true
    const id = tab.id
    try {
      const handoff = await invoke('browser:handoff', id)
      const active = useBrowser.getState().tabs.find((t) => t.active)
      if (!handoff || handoffRequest.current.disposed || active?.id !== id || active.url !== handoff.pageUrl) return
      void invoke('browser:pause', id)
      useTracking.getState().stop()
      await useTracking.getState().flushSave()
      const selected = useBrowser.getState().tabs.find((t) => t.active)
      if (handoffRequest.current.disposed || selected?.id !== id || selected.url !== handoff.pageUrl) return
      await usePlayer.getState().open(handoff.pageUrl, handoff.position, undefined, true, undefined, handoff)
    } catch (e) {
      console.warn('play in player', e)
    } finally {
      handoffRequest.current.pending = false
    }
  }
  const togglePage = () => {
    const b = useBrowser.getState()
    void (pagePlaying ? b.pause() : b.play())
  }
  const stateKey = STATE_LABEL[st]
  return (
    <>
      <div className={cx('trackbar', !browser && 'ptrack')}>
        {showState && (
          <>
            <span className="state">
              <span className={cx('dot', st === 'tracking' ? '' : st === 'locating' ? 'warn' : 'idle')} />
              {drm ? t('tracking.bar.protectedVideo') : stateKey ? t(stateKey) : st}
            </span>
            <span className="live-mini">
              <i style={{ transform: `scaleX(${pos / 100})` }} />
            </span>
            <span className="v">{pos}</span>
            <span className="vsep" />
          </>
        )}
        <div className="mid">
          {sections.map((src, i) => (
            <Fragment key={src}>
              {i > 0 && <span className="vsep" />}
              {src === 'beat' ? (
                <BeatControls bpm={!shared('beat', 'ai-music')} />
              ) : src === 'ai-music' ? (
                <MusicControls bpm={!shared('ai-music', 'beat')} />
              ) : src === 'ai-motion' ? (
                <MotionControls stroke={stroke === 'ai-motion'} region={!shared('ai-motion', 'video')} />
              ) : src === 'hero' ? (
                <HeroControls stroke={stroke === 'hero'} />
              ) : src === 'faptap' ? (
                <FaptapStatus />
              ) : (
                <>
                  <span className="lbl">{t('tracking.sensitivity')}</span>
                  <div className="sl sens">
                    <Slider value={[sensitivity * 10]} min={2} max={30} label={t('tracking.sensitivity')} onValueChange={([v]) => setSensitivity((v ?? 10) / 10)} />
                  </div>
                  <span className="v">{sensitivity.toFixed(1)}</span>
                  {stroke === 'video' && (
                    <>
                      <span className="lbl">{t('tracking.invert')}</span>
                      <Switch checked={invert} onCheckedChange={(on) => setAxis('L0', { invert: on })} label={t('tracking.invertStroke')} />
                    </>
                  )}
                  {!shared('video', 'ai-motion') && (
                    <>
                      <span className="lbl">{t('tracking.region')}</span>
                      <RegionSelect />
                    </>
                  )}
                </>
              )}
            </Fragment>
          ))}
        </div>
        {browser ? (
          <Button className={cx(axesOpen && 'on')} aria-expanded={axesOpen} onClick={() => setAxesOpen(!axesOpen)}>
            <SlidersHorizontal />
            {t('tracking.bar.axes')}
          </Button>
        ) : (
          <>
            <ZoneChip />
            <AxesPopover scripted={scripted} beat />
          </>
        )}
        {browser ? (
          <>
            {tab?.url && tab.url !== 'about:blank' && (
              <Button variant="primary" onClick={() => void playInPlayer()}>
                <MonitorPlay />
                {t('tracking.bar.playInPlayer')}
              </Button>
            )}
            <IconButton label={pagePlaying ? t('common.pause') : t('common.play')} disabled={!tab?.video?.present} onClick={togglePage}>
              {pagePlaying ? <Pause /> : <Play />}
            </IconButton>
          </>
        ) : (
          <>
            <Button icon aria-label={t('tracking.bar.downloadScript')} title={local ? t('tracking.bar.downloadScript') : t('tracking.bar.localOnly')} disabled={!local} onClick={() => void plan()}>
              <Download />
            </Button>
            <GenerateDialog />
          </>
        )}
      </div>
      {browser && axesOpen && (
        <div className="axes-panel">
          <AxesBody scripted={scripted} beat={false} browser />
        </div>
      )}
    </>
  )
}

function ZoneChip() {
  const t = useT()
  const zones = useTracking((s) => s.zones.zones)
  const leading = useTracking((s) => s.zoneMatches.find((m) => m.leading)?.id ?? null)
  const index = leading === null ? -1 : zones.findIndex((z) => z.id === leading)
  const zone = zones[index]
  if (!zone) return null
  return (
    <span className="chip on zone-chip">
      {zoneName(index, t)}
      <span className="sub">{describeEffect(zone.effect, t)}</span>
    </span>
  )
}

function FaptapStatus() {
  const t = useT()
  const enabled = useIntifaceEnabled()
  const port = useSettings((s) => s.settings?.intiface.port ?? INTIFACE_PORT_DEFAULT)
  const status = useIntifaceStatus()
  return (
    <>
      <span className="lbl">Faptap</span>
      <span className={cx('lbl', enabled && status.error && 'err')}>{enabled ? intifaceStatusLine(enabled, port, status) : t('tracking.bar.intifaceOff')}</span>
    </>
  )
}

function BpmChip() {
  const t = useT()
  const beat = useTracking((s) => s.beat)
  const beatError = useTracking((s) => s.beatError)
  const factor = useTracking((s) => s.beatTempoFactor)
  const setFactor = useTracking((s) => s.setBeatTempoFactor)
  const status = beatError ? beatError : beat?.status === 'analysing' ? t('tracking.bar.analysingAudio') : beat?.status === 'error' ? (beat.error ?? t('tracking.bar.noBeats')) : null
  return (
    <>
      <span className="bpm">
        <b>{beat?.status === 'ready' ? Math.round(beat.bpm) : '--'}</b>
        <span>BPM</span>
        <button type="button" className={cx(factor < 1 && 'on')} aria-label={t('tracking.bar.halfTempo')} onClick={() => setFactor(factor < 1 ? 1 : 0.5)}>
          ½
        </button>
        <button type="button" className={cx(factor > 1 && 'on')} aria-label={t('tracking.bar.doubleTempo')} onClick={() => setFactor(factor > 1 ? 1 : 2)}>
          ×2
        </button>
      </span>
      {status && <span className="lbl">{status}</span>}
    </>
  )
}

function PaceControl() {
  const t = useT()
  const pace = useTracking((s) => s.pace)
  const setPace = useTracking((s) => s.setPace)
  const percent = paceToSlider(pace)
  return (
    <>
      <span className="lbl">{t('tracking.bar.pace')}</span>
      <div className="sl pace">
        <Slider value={[percent]} step={5} label={t('tracking.bar.pace')} onValueChange={([v]) => setPace(paceFromSlider(v ?? 50))} />
      </div>
      <span className="v">{percent}%</span>
    </>
  )
}

function ModelChip({ state, present, busy }: { state: ModelState | null; present: boolean; busy?: { text: string; icon: React.ReactNode } | null }) {
  const t = useT()
  const chip = (tone: '' | 'warn', icon: React.ReactNode, text: string) => (
    <span className={cx('mchip', tone)}>
      {icon}
      {text}
    </span>
  )
  if (!present) return chip('warn', <AlertTriangle />, t('tracking.noModel'))
  if (!state || state.status === 'none' || state.status === 'loading') return chip('', <Loader />, t('tracking.bar.loading'))
  if (state.status === 'error') return chip('warn', <AlertTriangle />, state.error ?? t('tracking.bar.failed'))
  if (state.tooSlow) return chip('warn', <AlertTriangle />, t('tracking.bar.tooSlow'))
  if (busy) return chip('', busy.icon, busy.text)
  return null
}

function MotionControls({ stroke, region }: { stroke: boolean; region: boolean }) {
  const t = useT()
  const invert = useTracking((s) => s.axes.L0.invert)
  const setAxis = useTracking((s) => s.setAxis)
  const motion = useTracking((s) => s.motion)
  const present = useTracking((s) => s.present.motion)
  return (
    <>
      {stroke && (
        <>
          <span className="lbl">{t('tracking.invert')}</span>
          <Switch checked={invert} onCheckedChange={(on) => setAxis('L0', { invert: on })} label={t('tracking.invertStroke')} />
        </>
      )}
      {region && (
        <>
          <span className="lbl">{t('tracking.region')}</span>
          <RegionSelect />
        </>
      )}
      <PaceControl />
      <ModelChip state={motion} present={present} />
    </>
  )
}

function MusicControls({ bpm }: { bpm: boolean }) {
  const t = useT()
  const beat = useTracking((s) => s.beat)
  const music = useTracking((s) => s.music)
  const present = useTracking((s) => s.present.music)
  const pass = beat?.model
  const busy = pass?.status === 'modelling' ? { text: t('tracking.bar.modelling'), icon: <Waves /> } : pass?.status === 'error' ? { text: pass.error ?? t('tracking.bar.failed'), icon: <AlertTriangle /> } : pass?.status === 'watching' ? { text: t('tracking.bar.watching'), icon: <Eye /> } : pass?.status === 'ready' ? null : { text: t('tracking.bar.beatUntilReady'), icon: <Waves /> }
  return (
    <>
      {bpm && <BpmChip />}
      <PaceControl />
      {pass?.status === 'watching' && (
        <>
          <span className="pass" title={t('tracking.bar.watchingVideo')}>
            <i style={{ transform: `scaleX(${pass.percent / 100})` }} />
          </span>
          <span className="v">{Math.round(pass.percent)}%</span>
        </>
      )}
      <ModelChip state={music} present={present} busy={busy} />
    </>
  )
}

function BeatControls({ bpm }: { bpm: boolean }) {
  const t = useT()
  const volume = useSettings((s) => s.settings?.tracking.beatVolumeDepth ?? false)
  const setVolume = useTracking((s) => s.setBeatVolumeDepth)
  return (
    <>
      {bpm && <BpmChip />}
      <span className="vsep" />
      <span className="lbl" title={t('tracking.bar.depthByVolume')}>
        <Volume2 />
      </span>
      <Switch checked={volume} onCheckedChange={setVolume} label={t('tracking.bar.depthByVolume')} />
    </>
  )
}

type RegionChoice = 'auto' | RegionTarget | 'centre' | 'pick' | 'picked'

function RegionSelect() {
  const t = useT()
  const regionSource = useTracking((s) => s.regionSource)
  const regionTarget = useTracking((s) => s.regionTarget)
  const shown = useTracking((s) => s.regionShown)
  const setRegionSource = useTracking((s) => s.setRegionSource)
  const setRegionTarget = useTracking((s) => s.setRegionTarget)
  const detector = useTracking((s) => s.state?.detector.status ?? 'none')
  const found = useTracking((s) => targetLabel(s.state?.detector.found?.class))
  const model = useSettings((s) => s.settings?.tracking.models.detector ?? null)
  const ready = detector === 'ready'
  const auto = regionSource === 'auto'
  const hint = ready ? (auto ? (regionTarget ? (found ? null : t('tracking.bar.nothingFound')) : (found ?? t('tracking.bar.nothingFound'))) : null) : detector === 'loading' ? t('tracking.bar.loading') : detector === 'error' ? t('tracking.bar.failed') : model ? t('tracking.bar.notDownloaded') : t('tracking.noModel')
  const value: RegionChoice = auto ? (regionTarget ?? 'auto') : regionSource === 'pick' && !shown ? 'picked' : regionSource
  const choose = (choice: RegionChoice) => {
    if (choice === 'centre' || choice === 'pick') setRegionSource(choice)
    else if (choice !== 'picked') setRegionTarget(choice === 'auto' ? null : choice)
  }
  const options: ReadonlyArray<{ value: RegionChoice; label: string; disabled?: boolean; hidden?: boolean }> = [
    { value: 'auto', label: t('common.auto'), disabled: !ready },
    ...REGION_TARGETS.map((target) => ({ value: target, label: t(REGION_TARGET_LABEL[target]), disabled: !ready })),
    { value: 'centre', label: t('tracking.bar.centre') },
    { value: 'pick', label: t('tracking.bar.pick') },
    { value: 'picked', label: t('tracking.bar.pick'), hidden: true },
  ]
  return (
    <>
      <Select options={options} value={value} onChange={choose} label={t('tracking.region')} />
      {(auto || !ready) && hint && <span className="lbl">{hint}</span>}
    </>
  )
}

function AxesBody({ scripted, beat, browser = false }: { scripted: ReadonlySet<string>; beat: boolean; browser?: boolean }) {
  const t = useT()
  const axes = useTracking((s) => s.axes)
  const setAxis = useTracking((s) => s.setAxis)
  const key = useTracking((s) => s.key)
  const fps = useTracking((s) => s.state?.fps ?? 0)
  const aheadMs = useTracking((s) => s.state?.aheadMs ?? null)
  const setAsDefault = useTracking((s) => s.setAsDefault)
  const reset = useTracking((s) => s.reset)
  const restim = useDevices((s) => s.outputs.some((o) => o.config.profile === 'restim'))
  const present = useTracking((s) => s.present)
  const intiface = useIntifaceEnabled()
  return (
    <>
      <div className="ttl">{t('tracking.bar.axes')}</div>
      <AxesTable axes={axes} onChange={setAxis} scripted={scripted} beat={beat} present={present} faptap={browser ? (intiface ? 'ready' : 'off') : undefined} />
      {!browser && <Advanced />}
      {restim && (
        <div className="axnote">
          <Zap />
          {t('tracking.bar.restimNote')}
        </div>
      )}
      <div className="tfoot">
        <span className="note">
          {key ? t('tracking.savedForVideo') : t('tracking.bar.notSavedNoAddress')}
          {fps > 0 && ` · ${t('tracking.bar.fps', { fps: Math.round(fps) })}`}
          {aheadMs !== null && ` · ${t('tracking.bar.ahead', { seconds: Math.round(aheadMs / 1000) })}`}
        </span>
        <span className="acts">
          <Button variant="ghost" onClick={() => void setAsDefault()}>
            {t('tracking.bar.setAsDefault')}
          </Button>
          <Button variant="ghost" onClick={reset}>
            {t('common.reset')}
          </Button>
        </span>
      </div>
    </>
  )
}

function AxesPopover({ scripted, beat }: { scripted: ReadonlySet<string>; beat: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const zoneEdit = useTracking((s) => s.zoneEdit)
  useEffect(() => { if (zoneEdit) setOpen(false) }, [zoneEdit])
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button>
          <SlidersHorizontal />
          {t('tracking.bar.axes')}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="axes-pop" align="end" sideOffset={6} collisionPadding={12}>
          <AxesBody scripted={scripted} beat={beat} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

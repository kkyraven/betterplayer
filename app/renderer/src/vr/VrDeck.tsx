import { ArrowLeftRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, Glasses, LibraryBig, Locate, OctagonX, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Volume2, VolumeX, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { LAYOUTS, LAYOUT_LABELS, PROJECTION_KINDS, PROJECTION_LABELS, PROJECTION_SOURCE_LABELS, type Projection } from '@shared/projection'
import type { MessageKey } from '@shared/i18n'
import { VR_SKIP_SECONDS, type VrDeckState, type VrScreenSize } from '@shared/vr'
import { AxisChips } from '@/components/media/AxisChips'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { heatGradient } from '@/lib/heatmap'
import { useT } from '@/state/i18n'
import { command, useDeckState, type Received } from './panel'

const TICK_MS = 250
const SEEK_THROTTLE_MS = 100

const SCREEN_SIZES: { value: VrScreenSize; label: MessageKey }[] = [
  { value: 'small', label: 'subtitleSize.small' },
  { value: 'medium', label: 'subtitleSize.medium' },
  { value: 'large', label: 'subtitleSize.large' },
  { value: 'huge', label: 'vr.size.huge' },
]

const LENSES = ['180', '190', '200', '220'] as const

export function VrDeck() {
  const t = useT()
  const received = useDeckState()
  const clockMs = useClock(received)
  const hints = useHints()
  const [scrub, setScrub] = useState<number | null>(null)
  const held = useRef(false)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!held.current) setScrub(null)
  }, [received])

  if (!received) return <div className="vr-deck" />
  const { state } = received
  const timeMs = scrub !== null ? scrub * state.durationMs : clockMs
  const devices = state.devices.map((d, i) => (
    <span key={i} className="vd-dev">
      <span className={cx('dot', !d.connected && 'idle')} />
      {d.name}
    </span>
  ))
  const peek = state.peek?.shortcut
  const seeking = peek === 'seekBack' || peek === 'seekForward'
  const volumePeek = peek === 'volumeUp' || peek === 'volumeDown'
  return (
    <div className={cx('vr-deck', state.mode === 'open' && 'open', state.halted && 'halted')}>
      {state.loaded ? (
        <div className="vd-slab vd-strip">
          <div className="vd-r1">
            <span className="vd-title">{state.title}</span>
            <Status state={state} hints={hints} />
            <span className={cx('vd-time mono', seeking && 'lit')}>
              {fmtDuration(timeMs)} <span className="faint">/ {fmtDuration(state.durationMs)}</span>
            </span>
          </div>
          <Scrub
            heat={state.heat}
            fraction={state.durationMs > 0 ? Math.min(1, timeMs / state.durationMs) : 0}
            lit={seeking}
            onDrag={(f, done) => {
              held.current = !done
              setScrub(f)
            }}
            onSeek={(f) => command({ kind: 'seek', timeMs: f * state.durationMs })}
          />
          <div className="vd-r3">
            <AxisChips axes={state.axes} />
            {devices}
            <span className="vd-sp" />
            {(state.mode === 'open' || volumePeek) && <VolumeChip state={state} hints={hints} />}
          </div>
        </div>
      ) : (
        <div className="vd-slab vd-strip one">
          <div className="vd-r1">
            <span className="vd-title faint">{t('player.empty.nothingPlaying')}</span>
            <span className="vd-r3">{devices}</span>
          </div>
        </div>
      )}
      <div className="vd-slab vd-keys">
        {picking && state.loaded ? (
          <ViewPicker state={state} onDone={() => setPicking(false)} />
        ) : (
          <>
            <div className="vd-side">
              <Key label={t('screen.library')} on={state.screen} glyph={hints && !state.screen && <Face letter="B" />} onClick={() => command({ kind: 'screen', open: !state.screen })}>
                <LibraryBig />
              </Key>
              {state.loaded && (
                <Key label={t('library.toolbar.view')} onClick={() => setPicking(true)}>
                  <Glasses />
                </Key>
              )}
            </div>
            <div className="vd-transport">{state.loaded && <Transport state={state} hints={hints} />}</div>
            <div className="vd-side end">
              <Key label={t('vr.recentre')} glyph={hints && <><Stick side="L" Icon={ChevronsUpDown} /><span>{t('tracking.zones.hold')}</span></>} onClick={() => command({ kind: 'recentre', keepRecline: true })}>
                <Locate />
              </Key>
              <Key label={t('common.stop')} className="stop" on={state.halted} glyph={hints && <><Face letter="A" /><span className="vd-plus">+</span><Face letter="B" /></>} onClick={() => command({ kind: 'stop' })}>
                <OctagonX />
              </Key>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Transport({ state, hints }: { state: VrDeckState; hints: boolean }) {
  const t = useT()
  const paused = !state.playing || state.halted
  return (
    <>
      <Key round label={state.inSession ? t('player.controls.previousClip') : t('player.controls.previousVideo')} onClick={() => command({ kind: 'step', direction: -1 })}>
        <SkipBack />
      </Key>
      <Key round label={t('player.controls.back10')} glyph={hints && <Stick side="L" Icon={ChevronLeft} />} onClick={() => command({ kind: 'skip', seconds: -VR_SKIP_SECONDS })}>
        <RotateCcw />
      </Key>
      <Key round className={cx('play', state.halted && 'cue')} label={paused ? t('player.controls.play') : t('player.controls.pause')} glyph={hints && !state.halted && <Face letter="A" />} onClick={() => command({ kind: 'toggle' })}>
        {paused ? <Play /> : <Pause />}
      </Key>
      <Key round label={t('player.controls.forward10')} glyph={hints && <Stick side="L" Icon={ChevronRight} />} onClick={() => command({ kind: 'skip', seconds: VR_SKIP_SECONDS })}>
        <RotateCw />
      </Key>
      <Key round label={state.inSession ? t('player.controls.nextClip') : t('player.controls.nextVideo')} onClick={() => command({ kind: 'step', direction: 1 })}>
        <SkipForward />
      </Key>
    </>
  )
}

function Status({ state, hints }: { state: VrDeckState; hints: boolean }) {
  const t = useT()
  const peek = state.peek
  if (state.halted) {
    return (
      <span className="vd-st halted">
        <OctagonX />
        {t('app.holdToast.pausedKey', { key: t('common.play') })}
      </span>
    )
  }
  if (peek?.shortcut === 'seekBack' || peek?.shortcut === 'seekForward') {
    const back = peek.shortcut === 'seekBack'
    return (
      <span className="vd-st lit">
        {hints && <Stick side="L" Icon={back ? ChevronLeft : ChevronRight} />}
        {t('common.secondsShort', { value: `${back ? '−' : '+'}${peek.count * VR_SKIP_SECONDS}` })}
      </span>
    )
  }
  if (state.playing) return null
  return (
    <span className={cx('vd-st', peek?.shortcut === 'playPause' && 'lit')}>
      {peek?.shortcut === 'playPause' && hints ? <Face letter="A" /> : <Pause className="vd-fill" />}
      {t('settings.headsets.paused')}
    </span>
  )
}

function VolumeChip({ state, hints }: { state: VrDeckState; hints: boolean }) {
  const t = useT()
  const peek = state.peek?.shortcut
  const lit = peek === 'volumeUp' || peek === 'volumeDown'
  const percent = Math.round(state.volume * 100)
  return (
    <span className={cx('vd-vol', lit && 'lit')}>
      {hints && <Stick side="R" Icon={lit ? (peek === 'volumeUp' ? ChevronUp : ChevronDown) : ChevronsUpDown} />}
      {state.muted ? <VolumeX /> : <Volume2 />}
      {lit && !state.muted && (
        <span className="vd-meter">
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="mono">{state.muted ? t('tv.toast.muted') : `${percent}%`}</span>
    </span>
  )
}

function ViewPicker({ state, onDone }: { state: VrDeckState; onDone: () => void }) {
  const t = useT()
  const { projection, projectionSource } = state
  const auto = projectionSource !== 'user'
  const set = (next: Projection) => command({ kind: 'projection', projection: next })
  const source = PROJECTION_SOURCE_LABELS[projectionSource]
  const flat = projection.kind === 'flat'
  const fisheye = projection.kind === 'fisheye'
  const eyes = !flat || projection.layout !== 'mono'
  return (
    <div className="vd-picker">
      <button type="button" className={cx('vd-auto', auto && 'on')} aria-pressed={auto} onClick={() => !auto && command({ kind: 'projection', projection: null })}>
        <span className="a1">{t('common.auto')}</span>
        <span className="a2">{projection.layout === 'mono' ? t(PROJECTION_LABELS[projection.kind]) : t('vr.stereo', { kind: t(PROJECTION_LABELS[projection.kind]) })}</span>
        {source && <span className="a3">{t(source)}</span>}
      </button>
      <div className={cx('vd-rows', (flat ? eyes : fisheye) && 'three')}>
        <div className="vd-prow">
          <Seg options={PROJECTION_KINDS.map((k) => ({ value: k, label: t(PROJECTION_LABELS[k]) }))} value={projection.kind} auto={auto} label={t('player.sideSheet.projection')} onChange={(kind) => set({ ...projection, kind, layout: kind === 'flat' ? 'mono' : projection.layout })} />
        </div>
        {eyes && (
          <div className="vd-prow">
            <Seg options={LAYOUTS.map((l) => ({ value: l, label: t(LAYOUT_LABELS[l]) }))} value={projection.layout} auto={auto} label={t('player.sideSheet.eyes')} onChange={(layout) => set({ ...projection, layout })} />
            {projection.layout !== 'mono' && (
              <span className="vd-seg">
                <button type="button" className={cx(projection.swapEyes && (auto ? 'auto' : 'on'))} aria-pressed={projection.swapEyes} onClick={() => set({ ...projection, swapEyes: !projection.swapEyes })}>
                  <ArrowLeftRight />
                  {t('player.sideSheet.swapEyes')}
                </button>
              </span>
            )}
          </div>
        )}
        {flat && (
          <div className="vd-prow">
            <span className="vd-fl">
              {t('tv.playback.size')}
              <span className="faint">{t('library.section.all')}</span>
            </span>
            <Seg options={SCREEN_SIZES.map((s) => ({ value: s.value, label: t(s.label) }))} value={state.screenSize} auto={false} label={t('tv.playback.size')} onChange={(size) => command({ kind: 'screenSize', size })} />
          </div>
        )}
        {fisheye && (
          <div className="vd-prow">
            <span className="vd-fl">{t('player.sideSheet.lens')}</span>
            <Seg options={LENSES.map((l) => ({ value: l, label: `${l}°` }))} value={String(projection.fov)} auto={auto} label={t('player.sideSheet.lensCoverage')} onChange={(fov) => set({ ...projection, fov: Number(fov) })} />
          </div>
        )}
      </div>
      <Key label={t('common.done')} onClick={onDone}>
        <Check />
      </Key>
    </div>
  )
}

function Seg<T extends string>({ options, value, auto, label, onChange }: { options: { value: T; label: string }[]; value: T; auto: boolean; label: string; onChange: (value: T) => void }) {
  return (
    <span className="vd-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx(o.value === value && (auto ? 'auto' : 'on'))} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

function Key({ label, round = false, on = false, className, glyph, onClick, children }: { label: string; round?: boolean; on?: boolean; className?: string; glyph?: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={cx('vd-key', round && 'round', on && 'on', className)} aria-label={round ? label : undefined} onClick={onClick}>
      <span className="vd-ic">{children}</span>
      <span className="vd-lbl">{round ? '' : label}</span>
      <span className="vd-gl">{glyph}</span>
    </button>
  )
}

function Face({ letter }: { letter: string }) {
  return <span className="vd-face">{letter}</span>
}

function Stick({ side, Icon }: { side: 'L' | 'R'; Icon: LucideIcon }) {
  return (
    <span className="vd-stick">
      {side}
      <Icon aria-hidden />
    </span>
  )
}

function useHints(): boolean {
  const [hints, setHints] = useState(true)
  useEffect(() => {
    invoke('settings:get')
      .then((s) => setHints(s.tv.hints))
      .catch(() => {})
  }, [])
  return hints
}

function useClock(received: Received | null): number {
  const [now, setNow] = useState(() => performance.now())
  const playing = received?.state.playing ?? false
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => setNow(performance.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [playing])
  if (!received) return 0
  const { state, at } = received
  return state.playing ? Math.min(state.durationMs, state.timeMs + Math.max(0, now - at) * state.rate) : state.timeMs
}

function Scrub({ heat, fraction, lit, onDrag, onSeek }: { heat: readonly number[]; fraction: number; lit: boolean; onDrag: (fraction: number, done: boolean) => void; onSeek: (fraction: number) => void }) {
  const t = useT()
  const gradient = useMemo(() => heatGradient(heat), [heat])
  const dragging = useRef(false)
  const lastSeek = useRef(0)
  const at = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0
  }
  const seek = (f: number, force: boolean) => {
    const now = performance.now()
    if (!force && now - lastSeek.current < SEEK_THROTTLE_MS) return
    lastSeek.current = now
    onSeek(f)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>, done: boolean) => {
    if (!dragging.current) return
    dragging.current = !done
    const f = at(e)
    onDrag(f, done)
    seek(f, done)
  }
  const p = `${(fraction * 100).toFixed(3)}%`
  return (
    <div
      className="vd-scrub"
      role="slider"
      aria-label={t('player.scrubber.position')}
      aria-valuenow={Math.round(fraction * 100)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        dragging.current = true
        move(e, false)
      }}
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => move(e, true)}
      onPointerCancel={(e) => move(e, true)}
    >
      <div className="vd-heat" style={{ backgroundImage: gradient }} />
      <div className="vd-rest" style={{ left: p }} />
      <div className={cx('vd-knob', lit && 'lit')} style={{ left: p }} />
    </div>
  )
}

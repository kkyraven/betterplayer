import { Check, ChevronLeft, ChevronRight, Ellipsis, FileText, History, Keyboard, Pause, Play, RefreshCw, RotateCw, SkipBack, SkipForward, Cable, Download } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/Button'
import { DeviceViz } from '@/components/player/DeviceViz'
import { VideoSlot } from '@/components/player/VideoSlot'
import { DragBox } from '@/components/tracking/RegionBox'
import { keyLabel } from '@/input/actions'
import { funscriptStatus } from '@/editor/status'
import { fmtDuration, fmtTimecode, fmtWhen } from '@/lib/format'
import { cx } from '@/lib/cx'
import { useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import { SPEEDS, useEditor } from '@/state/editor'
import * as live from '@/state/live'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'
import { FillCard } from './FillCard'
import { Filmstrip } from './Filmstrip'
import { Inspector } from './Inspector'
import { Lanes } from './Lanes'
import { Minimap } from './Minimap'
import { OpCard, RecordCard, SelectByCard, SelectionContext } from './Cards'
import { PatternCard } from './PatternCard'
import { ExportDialog } from './ExportDialog'
import { MetadataSheet } from './MetadataSheet'
import { ShortcutSheet } from './ShortcutSheet'
import { EditorStart } from './EditorStart'
import { ToolStrip } from './ToolStrip'
import { Waveform } from './Waveform'
import './editor.css'

const MESSAGE_MS = 2500
const K = 'editor.screen.withKey'

export function EditorScreen() {
  const open = useEditor((s) => s.open)
  const message = useEditor((s) => s.message)
  const setMessage = useEditor((s) => s.setMessage)
  const draftOffer = useEditor((s) => s.draftOffer)
  const ghost = useEditor((s) => s.ghost)
  const recording = useEditor((s) => s.recording)
  const filmstrip = useEditor((s) => s.filmstrip)
  const waveform = useEditor((s) => s.waveform)
  const picking = useEditor((s) => s.ai.picking)
  const card = useEditor((s) => s.card)
  const t = useT()

  useEffect(() => {
    if (!message || !open) return
    const timer = window.setTimeout(() => setMessage(null), MESSAGE_MS)
    return () => window.clearTimeout(timer)
  }, [message, setMessage, open])

  if (!open) return <EditorStart />

  return (
    <div className="ed">
      <FileBar />
      <div className="ed-workspace">
        <ToolStrip />
        <div className="ed-upper">
          <div className="ed-video-block">
            <div className="ed-video-frame">
              <VideoSlot />
              {picking && <RegionPicker />}
              <DeviceViz />
              <FrameTime />
            </div>
            <Transport />
          </div>
          <aside className={cx('ed-context', card === 'pattern' && 'pattern')}>{open && <Context />}</aside>
        </div>
        <section className="ed-timeline" aria-label={t('editor.screen.timeline')}>
          {draftOffer && <DraftBar at={draftOffer.at} />}
          {ghost ? <ReviewBar /> : recording ? <RecordBar /> : <Inspector />}
          {filmstrip && <Filmstrip />}
          <Lanes />
          {waveform && <Waveform />}
        </section>
      </div>
      <Minimap />
      <StatusBar />
      {message && (
        <div className="ed-toast" role="status">
          {message}
        </div>
      )}
      <ShortcutSheet />
      <MetadataSheet />
      <ExportDialog />
    </div>
  )
}

function RegionPicker() {
  const t = useT()
  const region = useEditor((s) => s.ai.region)
  const setAi = useEditor((s) => s.setAi)
  return <DragBox region={region ?? { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }} label={t('editor.screen.region')} onChange={(r) => setAi({ region: r })} />
}

function FrameTime() {
  const ref = useRef<HTMLSpanElement>(null)
  live.useLive((l) => {
    const text = fmtTimecode(l.timeMs)
    if (ref.current && ref.current.textContent !== text) ref.current.textContent = text
  }, [])
  return <span ref={ref} className="frame-id" />
}

function FileBar() {
  const t = useT()
  const title = useEditor((s) => s.title)
  const dirty = useEditor((s) => s.dirty)
  const savedAt = useEditor((s) => s.savedAt)
  const exportedAt = useEditor((s) => s.exportedAt)
  const fileScript = useEditor((s) => s.fileScript)
  const behind = useEditor((s) => s.rev !== s.exportedRev)
  const canUndo = useEditor((s) => s.undoStack.length > 0)
  const canRedo = useEditor((s) => s.redoStack.length > 0)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const save = useEditor((s) => s.save)
  const setSheet = useEditor((s) => s.setSheet)
  const setScreen = useUi((s) => s.setScreen)
  const close = useEditor((s) => s.close)
  const library = dirty ? t('editor.screen.unsaved') : savedAt ? t('editor.screen.savedWhen', { when: fmtWhen(savedAt) }) : t('editor.screen.notSavedYet')
  const file = funscriptStatus(exportedAt, fileScript, behind)
  return (
    <header className="ed-filebar">
      <Button icon variant="ghost" aria-label={t('editor.start.back')} title={t('editor.start.back')} onClick={() => { usePlayer.getState().pause(); close() }}><ChevronLeft /></Button>
      <div className="crumb">
        <span>{t('editor.screen.title')}</span>
        <span aria-hidden="true">/</span>
        <h1>{title}</h1>
      </div>
      <span className="grow" />
      <span className={cx('ed-status', dirty && 'dirty', !dirty && !savedAt && 'off')}>
        <Check />
        <b>{t('editor.screen.library')}</b>
        <span>{library}</span>
      </span>
      <span className={cx('ed-status', file.warn && 'dirty', file.off && 'off')}>
        <FileText />
        <b>{t('editor.screen.funscript')}</b>
        <span>{t(file.key, { when: file.when })}</span>
      </span>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.screen.undo'), key: keyLabel('Editor.Undo') })} aria-label={t('editor.screen.undo')} disabled={!canUndo} onClick={undo}>
        <History />
      </button>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.screen.redo'), key: keyLabel('Editor.Redo') })} aria-label={t('editor.screen.redo')} disabled={!canRedo} onClick={redo}>
        <RotateCw />
      </button>
      <span className="ed-sep" />
      <Button title={t(K, { label: t('common.save'), key: keyLabel('Editor.Save') })} onClick={() => void save()}>
        {t('common.save')} <kbd>{keyLabel('Editor.Save')}</kbd>
      </Button>
      <Button title={t(K, { label: t('editor.screen.export'), key: keyLabel('Editor.Export') })} onClick={() => setSheet('export')}>
        <Download />
        {t('editor.screen.export')}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="ed-btn square" aria-label={t('editor.screen.more')} title={t('editor.screen.more')}>
            <Ellipsis />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
            <DropdownMenu.Item className="item" onSelect={() => setSheet('metadata')}>
              <FileText />
              {t('editor.screen.metadata')}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="item" onSelect={() => setSheet('shortcuts')}>
              <Keyboard />
              {t('editor.shortcuts.title')}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="sep" />
            <DropdownMenu.Item className="item" onSelect={() => setScreen('player')}>
              <ChevronLeft />
              {t('editor.screen.backToPlayer')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  )
}

function Transport() {
  const t = useT()
  const paused = usePlayer((s) => s.snapshot.paused)
  const rate = usePlayer((s) => s.snapshot.rate)
  const durationMs = useEditor((s) => s.durationMs)
  const loop = useEditor((s) => s.loop.on)
  const e = useEditor.getState
  const time = useRef<HTMLSpanElement>(null)
  live.useLive((l) => {
    const text = fmtTimecode(l.timeMs)
    if (time.current && time.current.textContent !== text) time.current.textContent = text
  }, [])
  const nextSpeed = () => {
    const i = SPEEDS.findIndex((r) => r >= rate - 0.001)
    e().setSpeed(SPEEDS[(i + 1) % SPEEDS.length] ?? 1)
  }
  return (
    <div className="ed-transport">
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.transport.previousPoint'), key: keyLabel('Editor.Point.Previous') })} aria-label={t('editor.transport.previousPoint')} onClick={() => e().stepPoint(-1)}>
        <SkipBack />
      </button>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.transport.frameBack'), key: keyLabel('Editor.Frame.Back') })} aria-label={t('editor.transport.frameBack')} onClick={() => e().frameStep(-1)}>
        <ChevronLeft />
      </button>
      <button type="button" className="ed-btn square play" title={t(K, { label: t(paused ? 'editor.transport.play' : 'editor.transport.pause'), key: keyLabel('Editor.Play.Toggle') })} aria-label={t(paused ? 'editor.transport.play' : 'editor.transport.pause')} onClick={() => e().togglePlay()}>
        {paused ? <Play /> : <Pause />}
      </button>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.transport.frameForward'), key: keyLabel('Editor.Frame.Forward') })} aria-label={t('editor.transport.frameForward')} onClick={() => e().frameStep(1)}>
        <ChevronRight />
      </button>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.transport.nextPoint'), key: keyLabel('Editor.Point.Next') })} aria-label={t('editor.transport.nextPoint')} onClick={() => e().stepPoint(1)}>
        <SkipForward />
      </button>
      <span className="time">
        <span ref={time}>{fmtTimecode(live.get().timeMs)}</span> <span>/ {fmtDuration(durationMs)}</span>
      </span>
      <button type="button" className="ed-btn speed" title={t('editor.transport.playbackSpeed')} onClick={nextSpeed}>
        {rate}×
      </button>
      <span className="grow" />
      <button type="button" className={cx('ed-btn', loop && 'on')} title={t(K, { label: t('editor.transport.loop'), key: keyLabel('Editor.Loop.Toggle') })} aria-pressed={loop} onClick={() => e().toggleLoop()}>
        <RefreshCw />
        {t('editor.transport.loop')}
      </button>
    </div>
  )
}

function Context() {
  const card = useEditor((s) => s.card)
  switch (card) {
    case 'pattern':
      return <PatternCard />
    case 'fill':
      return <FillCard />
    case 'record':
      return <RecordCard />
    case 'selectBy':
      return <SelectByCard />
    case null:
      return <SelectionContext />
    default:
      return <OpCard kind={card} />
  }
}

function DraftBar({ at }: { at: number }) {
  const t = useT()
  const restore = useEditor((s) => s.restoreDraft)
  const discard = useEditor((s) => s.discardDraft)
  return (
    <div className="ed-review draft">
      <div className="title">
        <strong>{t('editor.draft.title')}</strong>
        <span>{new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <span className="grow" />
      <Button variant="ghost" onClick={discard}>
        {t('editor.screen.discard')}
      </Button>
      <Button variant="primary" onClick={restore}>
        {t('editor.draft.restore')}
      </Button>
    </div>
  )
}

function ReviewBar() {
  const t = useT()
  const ghost = useEditor((s) => s.ghost)
  const fps = useEditor((s) => s.fps)
  const e = useEditor.getState
  if (!ghost) return null
  const n = ghost.base.length
  const frames = Math.round(ghost.phaseMs / (1000 / fps))
  return (
    <div className="ed-review">
      <span className="legend" />
      <div className="title">
        <strong>
          {ghost.label} · {t('editor.review.strokes', { count: n })}
        </strong>
        {ghost.note && <span>{ghost.note}</span>}
      </div>
      <span className="ed-sep" />
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.review.previousStroke'), key: keyLabel('Editor.Ghost.Previous') })} aria-label={t('editor.review.previousStroke')} onClick={() => e().ghostWalk(-1)}>
        <ChevronLeft />
      </button>
      <span className="walk">{ghost.walk === -1 ? t('editor.review.allStrokes') : t('editor.review.strokeOf', { n: ghost.walk + 1, total: n })}</span>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.review.nextStroke'), key: keyLabel('Editor.Ghost.Next') })} aria-label={t('editor.review.nextStroke')} onClick={() => e().ghostWalk(1)}>
        <ChevronRight />
      </button>
      <span className="grow" />
      <span className="lbl">{t('editor.review.phase')}</span>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.review.earlier'), key: keyLabel('Editor.Ghost.Earlier') })} aria-label={t('editor.review.earlier')} onClick={() => e().ghostAdjust(-1000 / fps, 1)}>
        <ChevronLeft />
      </button>
      <span className="mono lbl">
        {frames > 0 ? '+' : ''}
        {frames}f
      </span>
      <button type="button" className="ed-btn square" title={t(K, { label: t('editor.review.later'), key: keyLabel('Editor.Ghost.Later') })} aria-label={t('editor.review.later')} onClick={() => e().ghostAdjust(1000 / fps, 1)}>
        <ChevronRight />
      </button>
      <span className="lbl">{t('editor.review.depth')}</span>
      <span className="mono lbl">{Math.round(ghost.depth * 100)}%</span>
      <Button variant="ghost" onClick={() => e().dropGhost()}>
        {t('editor.screen.discard')} <kbd>Esc</kbd>
      </Button>
      <Button variant="primary" onClick={() => e().acceptGhost()}>
        {t(ghost.walk === -1 ? 'editor.review.acceptAll' : 'editor.review.acceptStroke')} <kbd>{keyLabel('Editor.Point.Alternate').split(' ')[0]}</kbd>
      </Button>
    </div>
  )
}

function RecordBar() {
  const t = useT()
  const input = useEditor((s) => s.recordInput)
  const pos = useEditor((s) => s.recordPosNow)
  const focused = useEditor((s) => s.focused)
  const rate = usePlayer((s) => s.snapshot.rate)
  const stop = useEditor((s) => s.stopRecord)
  const time = useRef<HTMLSpanElement>(null)
  live.useLive((l) => {
    const text = fmtTimecode(l.timeMs)
    if (time.current && time.current.textContent !== text) time.current.textContent = text
  }, [])
  return (
    <div className="ed-review record">
      <i className="dot" />
      <strong>{t('editor.record.title')}</strong>
      <span ref={time} className="mono" />
      <span>
        {t(input === 'mouse' ? 'editor.record.mouse' : 'editor.record.gamepad')} · {focused} · {rate}×
      </span>
      <span className="grow" />
      <span>
        {t('editor.record.position')} <b className="mono">{pos}</b>
      </span>
      <Button onClick={stop}>
        {t('editor.record.stopAndReview')} <kbd>Space</kbd>
      </Button>
    </div>
  )
}

function StatusBar() {
  const t = useT()
  const connected = useDevices((s) => Object.values(s.states).some((o) => o?.status === 'connected'))
  const setSheet = useEditor((s) => s.setSheet)
  return (
    <footer className="ed-statusbar">
      <span>
        <kbd>{keyLabel('Editor.Point.Alternate').split(' ')[0]}</kbd>{t('editor.statusBar.alternate')}
      </span>
      <span>
        <kbd>0–9</kbd>{t('editor.statusBar.pointAtPlayhead')}
      </span>
      <span className="extra">
        <kbd>Alt</kbd>{t('editor.statusBar.placeWithoutSnap')}
      </span>
      <span className="extra">
        <kbd>←</kbd> <kbd>→</kbd>{t('editor.statusBar.frameStep')}
      </span>
      <span className="grow" />
      {connected && (
        <span className="ok">
          <Cable />
          {t('editor.statusBar.deviceFollows')}
        </span>
      )}
      <button type="button" onClick={() => setSheet('shortcuts')}>
        <span>
          <kbd>?</kbd>{t('editor.shortcuts.title')}
        </span>
      </button>
    </footer>
  )
}

import { CircleDot, Repeat2, Scan, X } from 'lucide-react'
import { useMemo } from 'react'
import { AXIS_NAME } from '@shared/axes'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { selectionSpan, shapeOf } from '@/editor/ops'
import { ACTIONS, keyLabel, type ActionId } from '@/input/actions'
import { fmtTimecode } from '@/lib/format'
import { useEditor, type CardKind, type QuantiseTo, type RecordInput, type SelectBy } from '@/state/editor'
import { useT } from '@/state/i18n'
import { ShapeSvg } from './PatternCard'

const CARD_ACTION: Partial<Record<CardKind, ActionId>> = { simplify: 'Editor.Simplify', scaleDepth: 'Editor.ScaleDepth', scaleTime: 'Editor.ScaleTime', rangeExtend: 'Editor.RangeExtend', loop: 'Editor.Loop', quantise: 'Editor.Quantise', limitSpeed: 'Editor.LimitSpeed' }

export function RecordCard() {
  const t = useT()
  const input = useEditor((s) => s.recordInput)
  const recording = useEditor((s) => s.recording)
  const pos = useEditor((s) => s.recordPosNow)
  const focused = useEditor((s) => s.focused)
  const setRecordInput = useEditor((s) => s.setRecordInput)
  const startRecord = useEditor((s) => s.startRecord)
  const stopRecord = useEditor((s) => s.stopRecord)
  const setCard = useEditor((s) => s.setCard)
  return (
    <>
      <div className="ed-card-hd">
        <CircleDot />
        <h2>{t('editor.cards.recordTitle', { axis: t(AXIS_NAME[focused]) })}</h2>
        <button type="button" className="ed-btn" aria-label={t('common.close')} title={t('common.close')} onClick={() => setCard(null)}>
          <X />
        </button>
      </div>
      <label className="ed-field">
        <span>{t('editor.cards.input')}</span>
        <Select<RecordInput>
          options={[
            { value: 'mouse', label: t('editor.cards.mouseOverLane') },
            { value: 'gamepad', label: t('editor.cards.gamepadStick') },
            { value: 'device', label: t('editor.cards.deviceSlider') },
          ]}
          value={input}
          label={t('editor.cards.recordingInput')}
          onChange={setRecordInput}
        />
      </label>
      {input === 'device' && <p className="ed-hint">{t('editor.cards.deviceHint')}</p>}
      <div className="ed-record-pos">
        {pos} <small>/ 100</small>
      </div>
      <div className="ed-meter">
        <i style={{ '--p': pos / 100 } as React.CSSProperties} />
      </div>
      <div className="ed-card-foot">
        <span className="grow" />
        {recording ? (
          <Button variant="primary" onClick={stopRecord}>
            {t('editor.record.stopAndReview')} <kbd>Space</kbd>
          </Button>
        ) : (
          <Button variant="primary" onClick={startRecord}>
            {t('editor.cards.start')}
          </Button>
        )}
      </div>
      <div className="ed-shortcuts">
        <span>
          {t('editor.record.stopAndReview')} <kbd>Space</kbd>
        </span>
        <span>
          {t('editor.screen.discard')} <kbd>Esc</kbd>
        </span>
      </div>
    </>
  )
}

export function OpCard({ kind }: { kind: CardKind }) {
  const t = useT()
  const params = useEditor((s) => s.cardParams)
  const setParams = useEditor((s) => s.setCardParams)
  const ghost = useEditor((s) => s.ghost)
  const acceptGhost = useEditor((s) => s.acceptGhost)
  const dropGhost = useEditor((s) => s.dropGhost)
  const setCard = useEditor((s) => s.setCard)
  const beats = useEditor((s) => s.beats)
  const ensureBeats = useEditor((s) => s.ensureBeats)
  const action = CARD_ACTION[kind]
  const label = action ? t(ACTIONS[action].label) : kind
  const close = () => {
    dropGhost()
    setCard(null)
  }
  let control: React.ReactNode
  switch (kind) {
    case 'simplify':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.tolerance')}</span>
          <Slider value={[params.simplifyEps * 100]} min={0.5} max={15} step={0.5} label={t('editor.cards.tolerance')} onValueChange={(v) => setParams({ simplifyEps: (v[0] ?? 2) / 100 })} />
          <output>{(params.simplifyEps * 100).toFixed(1)}</output>
        </div>
      )
      break
    case 'scaleDepth':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.depth')}</span>
          <Slider value={[params.depthFactor * 100]} min={10} max={200} step={5} label={t('editor.cards.depth')} onValueChange={(v) => setParams({ depthFactor: (v[0] ?? 100) / 100 })} />
          <output>{Math.round(params.depthFactor * 100)}%</output>
        </div>
      )
      break
    case 'scaleTime':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.time')}</span>
          <Slider value={[params.timeFactor * 100]} min={25} max={300} step={5} label={t('editor.cards.time')} onValueChange={(v) => setParams({ timeFactor: (v[0] ?? 100) / 100 })} />
          <output>{Math.round(params.timeFactor * 100)}%</output>
        </div>
      )
      break
    case 'rangeExtend':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.range')}</span>
          <NumberInput value={params.rangeMin} min={0} max={99} label={t('editor.cards.rangeMin')} onChange={(rangeMin) => setParams({ rangeMin: Math.min(rangeMin, params.rangeMax - 1) })} />
          <span className="val">{t('editor.fill.to')}</span>
          <NumberInput value={params.rangeMax} min={1} max={100} label={t('editor.cards.rangeMax')} onChange={(rangeMax) => setParams({ rangeMax: Math.max(rangeMax, params.rangeMin + 1) })} />
        </div>
      )
      break
    case 'loop':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.times')}</span>
          <NumberInput value={params.loopTimes} min={1} max={200} label={t('editor.cards.times')} onChange={(loopTimes) => setParams({ loopTimes })} />
        </div>
      )
      break
    case 'limitSpeed':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.limit')}</span>
          <Slider value={[params.speedLimit]} min={50} max={1000} step={10} label={t('editor.cards.speedLimit')} onValueChange={(v) => setParams({ speedLimit: v[0] ?? 400 })} />
          <output>{params.speedLimit}/s</output>
        </div>
      )
      break
    case 'quantise':
      control = (
        <div className="ed-field">
          <span>{t('editor.cards.to')}</span>
          <Segmented<QuantiseTo>
            label={t('editor.cards.quantiseTo')}
            value={params.quantiseTo}
            options={[
              { value: 'frames', label: t('editor.cards.frames') },
              { value: 'beats', label: t('editor.cards.beats'), disabled: beats === null, title: beats === null ? t('editor.cards.analysingAudio') : undefined },
              { value: 'turns', label: t('editor.cards.turns') },
            ]}
            onChange={(quantiseTo) => setParams({ quantiseTo })}
          />
        </div>
      )
      if (beats === null) void ensureBeats()
      break
    default:
      control = null
  }
  return (
    <>
      <div className="ed-card-hd">
        <Repeat2 />
        <h2>{label}</h2>
        <button type="button" className="ed-btn" aria-label={t('common.close')} title={t('common.close')} onClick={close}>
          <X />
        </button>
      </div>
      <div className="ed-fields">{control}</div>
      {!ghost && <p className="ed-hint">{t('editor.cards.selectPointsFirst')}</p>}
      <div className="ed-card-foot">
        <Button variant="ghost" onClick={close}>
          {t('common.cancel')}
        </Button>
        <span className="grow" />
        <Button variant="primary" disabled={!ghost} onClick={acceptGhost}>
          {t('editor.cards.apply')} <kbd>{keyLabel('Editor.Point.Alternate').split(' ')[0]}</kbd>
        </Button>
      </div>
    </>
  )
}

export function SelectByCard() {
  const t = useT()
  const params = useEditor((s) => s.cardParams)
  const setParams = useEditor((s) => s.setCardParams)
  const count = useEditor((s) => s.selection.size)
  const setCard = useEditor((s) => s.setCard)
  const speed = params.selectBy === 'speed'
  const setMode = (selectBy: SelectBy) => setParams(selectBy === 'speed' ? { selectBy, selectMin: 300, selectMax: 1000 } : { selectBy, selectMin: 0, selectMax: 30 })
  return (
    <>
      <div className="ed-card-hd">
        <Repeat2 />
        <h2>{t('editor.cards.selectBy')}</h2>
        <button type="button" className="ed-btn" aria-label={t('common.close')} title={t('common.close')} onClick={() => setCard(null)}>
          <X />
        </button>
      </div>
      <div className="ed-fields">
        <div className="ed-field">
          <span>{t('editor.cards.by')}</span>
          <Segmented<SelectBy>
            label={t('editor.cards.selectBy')}
            value={params.selectBy}
            options={[
              { value: 'speed', label: t('editor.cards.speed') },
              { value: 'depth', label: t('editor.cards.depth') },
            ]}
            onChange={setMode}
          />
        </div>
        <div className="ed-field">
          <span>{t(speed ? 'editor.cards.unitsPerSecond' : 'editor.cards.position')}</span>
          <NumberInput value={params.selectMin} min={0} max={speed ? 5000 : 100} label={t('editor.cards.from')} onChange={(selectMin) => setParams({ selectMin: Math.min(selectMin, params.selectMax) })} />
          <span className="val">{t('editor.fill.to')}</span>
          <NumberInput value={params.selectMax} min={0} max={speed ? 5000 : 100} label={t('editor.cards.to')} onChange={(selectMax) => setParams({ selectMax: Math.max(selectMax, params.selectMin) })} />
        </div>
      </div>
      <p className="ed-hint">{t('editor.cards.pointsSelected', { count })}</p>
      <div className="ed-card-foot">
        <span className="grow" />
        <Button variant="primary" onClick={() => setCard(null)}>
          {t('common.done')}
        </Button>
      </div>
    </>
  )
}

function FirstPoint() {
  const t = useT()
  return (
    <>
      <div className="ed-card-hd">
        <h2>{t('editor.cards.firstPoint')}</h2>
      </div>
      <ol className="ed-steps">
        <li>
          <span>{t('editor.cards.stepToFrame')}</span>
          <kbd>←</kbd> <kbd>→</kbd>
        </li>
        <li>
          <span>{t('editor.cards.pressDepth')}</span>
          <kbd>0–9</kbd>
        </li>
        <li>
          <span>{t('editor.cards.addOpposite')}</span>
          <kbd>{keyLabel('Editor.Point.Alternate').split(' ')[0]}</kbd>
        </li>
      </ol>
      <div className="ed-shortcuts">
        <span>
          {t('editor.cards.play')} <kbd>{keyLabel('Editor.Play.Toggle')}</kbd>
        </span>
        <span>
          {t('editor.screen.undo')} <kbd>{keyLabel('Editor.Undo')}</kbd>
        </span>
      </div>
    </>
  )
}

export function SelectionContext() {
  const t = useT()
  const lanes = useEditor((s) => s.lanes)
  const focused = useEditor((s) => s.focused)
  const selection = useEditor((s) => s.selection)
  const setCard = useEditor((s) => s.setCard)
  const refit = useEditor((s) => s.refit)
  const info = useMemo(() => {
    const lane = lanes.find((l) => l.axis === focused)
    if (!lane) return null
    const span = selectionSpan(lane.points, selection)
    if (!span) return null
    return { span, shape: shapeOf(lane.points.filter((p) => selection.has(p.at))) }
  }, [lanes, focused, selection])
  const empty = lanes.find((l) => l.axis === focused)?.points.length === 0
  if (empty) return <FirstPoint />
  return (
    <>
      <div className="ed-card-hd">
        <h2>{info ? t('editor.cards.selection') : t(AXIS_NAME[focused])}</h2>
        {info && <span className="ed-hint">{t(AXIS_NAME[focused])}</span>}
      </div>
      {info ? (
        <>
          <div className="ed-shape">{info.shape && <ShapeSvg points={info.shape} />}</div>
          <div className="ed-range">
            {fmtTimecode(info.span.startMs)}
            <span className="faint">→</span>
            {fmtTimecode(info.span.endMs)}
          </div>
          <div className="actions">
            <Button onClick={() => setCard('pattern')}>
              <Repeat2 />
              {t('editor.cards.patternFill')} <kbd>{keyLabel('Editor.Fill')}</kbd>
            </Button>
            <Button onClick={refit}>
              <Scan />
              {t('editor.cards.refitTiming')} <kbd>{keyLabel('Editor.Refit')}</kbd>
            </Button>
          </div>
        </>
      ) : (
        <p className="ed-hint">{t('editor.cards.selectHint')}</p>
      )}
      <div className="ed-shortcuts">
        <span>
          {t('editor.cards.alternatePoint')} <kbd>{keyLabel('Editor.Point.Alternate').split(' ')[0]}</kbd>
        </span>
        <span>
          {t('editor.statusBar.frameStep')} <kbd>←</kbd> <kbd>→</kbd>
        </span>
        <span>
          {t('editor.cards.patternFill')} <kbd>{keyLabel('Editor.Fill')}</kbd>
        </span>
        <span>
          {t('editor.cards.nextLane')} <kbd>{keyLabel('Editor.Lane.Next')}</kbd>
        </span>
      </div>
    </>
  )
}

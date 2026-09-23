import { Check, ChevronDown, Folder, MousePointer2, PencilRuler, Plus, Repeat2, RotateCw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AXIS_NAME } from '@shared/axes'
import { PATTERN_NAME_MAX, type Pattern } from '@shared/editor'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Select } from '@/components/ui/Select'
import { PATTERN_PRESETS, patternName } from '@/editor/presets'
import type { HeightMode } from '@/editor/patterns'
import { keyLabel } from '@/input/actions'
import { cx } from '@/lib/cx'
import { FILL_TO_LABEL, useEditor, type FillTo } from '@/state/editor'
import { useT } from '@/state/i18n'
type Shape = Array<[number, number]>

export function ShapeSvg({ points, editable = false, compact = false, onChange }: { points: Shape; editable?: boolean; compact?: boolean; onChange?: (points: Shape) => void }) {
  const t = useT()
  const ref = useRef<SVGSVGElement>(null)
  const drag = useRef<{ index: number } | null>(null)
  const coords = points.map(([p, h]) => [15 + p * 270, 130 - h * 1.1] as const)
  const position = (ev: { clientX: number; clientY: number }): [number, number] => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    return [(ev.clientX - rect.left - rect.width * 0.05) / (rect.width * 0.9), ((rect.height * (130 / 145) - (ev.clientY - rect.top)) / (rect.height * (110 / 145))) * 100]
  }
  const moveTo = (index: number, x: number, y: number) => {
    const next = points.map(([p, h]) => [p, h] as [number, number])
    const prev = next[index - 1]
    const after = next[index + 1]
    const phase = index === 0 ? 0 : index === next.length - 1 ? 1 : Math.max((prev?.[0] ?? 0) + 0.01, Math.min((after?.[0] ?? 1) - 0.01, x))
    const height = Math.max(0, Math.min(100, Math.round(y)))
    next[index] = [phase, height]
    const lastIndex = next.length - 1
    const first = next[0]
    const last = next[lastIndex]
    if (index === 0 && last) next[lastIndex] = [last[0], height]
    if (index === lastIndex && first) next[0] = [first[0], height]
    onChange?.(next)
  }
  const onDown = (ev: ReactPointerEvent<SVGElement>, index: number | null) => {
    if (!editable || ev.button !== 0) return
    ev.preventDefault()
    let i = index
    if (i === null) {
      const [x, y] = position(ev)
      if (x <= 0 || x >= 1 || points.some((p) => Math.abs(p[0] - x) < 0.015)) return
      const added: [number, number] = [x, Math.max(0, Math.min(100, Math.round(y)))]
      const next: Shape = [...points, added].sort((a, b) => a[0] - b[0])
      onChange?.(next)
      i = next.findIndex((p) => p[0] === x)
    }
    drag.current = { index: i }
    ref.current?.setPointerCapture(ev.pointerId)
  }
  const onMove = (ev: ReactPointerEvent<SVGElement>) => {
    if (!drag.current) return
    const [x, y] = position(ev)
    moveTo(drag.current.index, x, y)
  }
  const onUp = () => {
    drag.current = null
  }
  const onKey = (ev: ReactKeyboardEvent<SVGCircleElement>, index: number) => {
    const p = points[index]
    if (!p) return
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (index > 0 && index < points.length - 1) onChange?.(points.filter((_, i) => i !== index))
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    const dx = ev.key === 'ArrowRight' ? 0.01 : ev.key === 'ArrowLeft' ? -0.01 : 0
    const dy = ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowDown' ? -1 : 0
    if (dx === 0 && dy === 0) return
    ev.preventDefault()
    ev.stopPropagation()
    moveTo(index, p[0] + dx, p[1] + dy)
  }
  return (
    <svg ref={ref} viewBox="0 0 300 145" preserveAspectRatio="none" aria-label={editable ? t('editor.pattern.drawing') : undefined} aria-hidden={editable ? undefined : true} onPointerDown={(ev) => onDown(ev, null)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {!compact && <path className="grid" d="M15 20H285 M15 75H285 M15 130H285 M15 20V130 M82.5 20V130 M150 20V130 M217.5 20V130 M285 20V130" fill="none" />}
      <polyline points={coords.map((c) => c.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth={compact ? 1.5 : 2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {editable &&
        coords.map(([cx_, cy], i) => (
          <circle
            key={i}
            className="pt"
            cx={cx_}
            cy={cy}
            r={4}
            tabIndex={0}
            role="slider"
            aria-label={t('editor.pattern.pointHeight', { n: i + 1 })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={points[i]?.[1] ?? 0}
            onPointerDown={(ev) => {
              ev.stopPropagation()
              onDown(ev, i)
            }}
            onKeyDown={(ev) => onKey(ev, i)}
          />
        ))}
    </svg>
  )
}

const HEIGHT_LABEL: Record<HeightMode, MessageKey> = { pattern: 'editor.pattern.height.pattern', motion: 'editor.pattern.height.motion', range: 'editor.pattern.height.range' }
const FULL: Shape = [[0, 0], [0.5, 100], [1, 0]]

interface Draft {
  id: string | null
  name: string
  points: Shape
}

export function PatternCard() {
  const t = useT()
  const fillTo = (Object.keys(FILL_TO_LABEL) as FillTo[]).map((value) => ({ value, label: t(FILL_TO_LABEL[value]) }))
  const heights = (Object.keys(HEIGHT_LABEL) as HeightMode[]).map((value) => ({ value, label: t(HEIGHT_LABEL[value]) }))
  const pattern = useEditor((s) => s.pattern)
  const patterns = useEditor((s) => s.patterns)
  const fill = useEditor((s) => s.fill)
  const focused = useEditor((s) => s.focused)
  const selection = useEditor((s) => s.selection)
  const lanes = useEditor((s) => s.lanes)
  const analysisVersion = useEditor((s) => s.analysisVersion)
  const picker = useEditor((s) => s.patternPicker)
  const editing = useEditor((s) => s.patternEditing)
  const setPatternUi = useEditor((s) => s.setPatternUi)
  const setPattern = useEditor((s) => s.setPattern)
  const setFill = useEditor((s) => s.setFill)
  const setCard = useEditor((s) => s.setCard)
  const fillPattern = useEditor((s) => s.fillPattern)
  const savePattern = useEditor((s) => s.savePattern)
  const deletePattern = useEditor((s) => s.deletePattern)
  const takeFromSelection = useEditor((s) => s.takePatternFromSelection)
  const [draft, setDraft] = useState<Draft>({ id: null, name: '', points: FULL })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<'mine' | 'presets'>(patterns.length > 0 ? 'mine' : 'presets')
  const [, setTick] = useState(0)
  useEffect(() => {    const timer = window.setInterval(() => setTick((x) => x + 1), 500)
    return () => window.clearInterval(timer)
  }, [])
  const span = useEditor.getState().fillSpan()
  const nameRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!picker) return
    const onDown = (ev: PointerEvent) => {
      const target = ev.target
      if (target instanceof Node && (pickerRef.current?.contains(target) || (target instanceof Element && target.closest('.ed-pattern-select')))) return
      setPatternUi({ picker: false })
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [picker, setPatternUi])

  const startEdit = (from: 'new' | 'edit' | 'selection') => {
    let next: Draft = { id: null, name: '', points: FULL }
    if (from === 'edit') next = { id: pattern.builtin ? null : pattern.id, name: pattern.builtin ? t('editor.pattern.copyName', { name: patternName(pattern, t) }) : pattern.name, points: pattern.points.map((p) => [p[0], p[1]]) }
    if (from === 'selection') {
      const points = takeFromSelection()
      if (!points) return
      next = { id: null, name: t('editor.pattern.selectionPattern'), points }
    }
    setDraft(next)
    setError('')
    setNotice('')
    setPatternUi({ picker: false, editing: true })
    window.setTimeout(() => nameRef.current?.focus(), 0)
  }
  const save = async () => {
    const name = draft.name.trim().slice(0, PATTERN_NAME_MAX)
    if (!name) return
    if (patterns.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== draft.id)) {
      setError(t('editor.pattern.nameUsed'))
      return
    }
    await savePattern(name, draft.points, draft.id ?? undefined)
    setPatternUi({ editing: false })
    setGroup('mine')
    setNotice(t('editor.pattern.savedAcrossVideos'))
  }
  const remove = async () => {
    if (!draft.id) return
    await deletePattern(draft.id)
    setPatternUi({ editing: false })
  }
  const pick = (p: Pattern) => {
    setPattern(p)
    setPatternUi({ picker: false })
    setNotice('')
  }
  const listed = useMemo(() => {
    const source = group === 'mine' ? patterns : PATTERN_PRESETS
    const q = search.trim().toLowerCase()
    return q ? source.filter((p) => patternName(p, t).toLowerCase().includes(q)) : source
  }, [group, patterns, search, t])
  const seconds = span ? ((span.endMs - span.startMs) / 1000).toFixed(3) : null
  void lanes
  void analysisVersion

  if (editing) {
    return (
      <section className="ed-pattern" aria-label={t(draft.id ? 'editor.pattern.edit' : 'editor.pattern.new')}>
        <div className="ed-pattern-hd">
          <PencilRuler />
          <h2>{t(draft.id ? 'editor.pattern.edit' : 'editor.pattern.new')}</h2>
        </div>
        <div className="ed-pattern-body edit">
          <label className="ed-name-field">
            <span>{t('editor.pattern.name')}</span>
            <input ref={nameRef} value={draft.name} maxLength={PATTERN_NAME_MAX} placeholder={t('editor.pattern.namePlaceholder')} autoComplete="off" onChange={(ev) => setDraft({ ...draft, name: ev.target.value })} onKeyDown={(ev) => ev.key === 'Enter' && void save()} />
          </label>
          {error && (
            <div className="ed-error" role="alert">
              {error}
            </div>
          )}
          <div className="ed-shape editable tall" aria-label={t('editor.pattern.drawing')}>
            <ShapeSvg points={draft.points} editable onChange={(points) => setDraft({ ...draft, points })} />
          </div>
          <div className="ed-shape-caption">
            <span>0%</span>
            <span>{t('editor.pattern.oneCycle')}</span>
            <span>100%</span>
          </div>
          <div className="ed-edit-tools">
            <button type="button" className="ed-btn" disabled={selection.size < 2} onClick={() => startEdit('selection')}>
              <MousePointer2 />
              {t('editor.pattern.fromSelection')}
            </button>
            <button type="button" className="ed-btn square" aria-label={t('editor.pattern.resetDrawing')} title={t('editor.pattern.resetDrawing')} onClick={() => setDraft({ ...draft, points: FULL })}>
              <RotateCw />
            </button>
            <span>{t('editor.pattern.clickAddsPoints')}</span>
          </div>
        </div>
        <div className="ed-pattern-foot">
          <div className="ed-save-dest">
            <Folder />
            {t('editor.pattern.myPatterns')}
            <span className="grow" />
            {t('editor.pattern.acrossVideos')}
          </div>
          <div className="ed-save-foot">
            <Button variant="ghost" onClick={() => setPatternUi({ editing: false })}>
              {t('common.cancel')}
            </Button>
            {draft.id && (
              <Button variant="ghost" className="btn-danger" onClick={() => void remove()}>
                <Trash2 />
                {t('common.delete')}
              </Button>
            )}
            <Button variant="primary" className="save" disabled={!draft.name.trim()} onClick={() => void save()}>
              {t('editor.pattern.savePattern')}
            </Button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="ed-pattern" aria-label={t('editor.pattern.fill')}>
      <div className="ed-pattern-hd">
        <Repeat2 />
        <h2>{t('editor.pattern.title')}</h2>
        <button type="button" className="ed-btn" onClick={() => startEdit('new')}>
          <Plus />
          {t('editor.pattern.new')}
        </button>
        <button type="button" className="ed-btn square" aria-label={t('common.close')} title={t('common.close')} onClick={() => setCard(null)}>
          <X />
        </button>
      </div>
      <div className="ed-pattern-body">
        <button type="button" className="ed-pattern-select" aria-haspopup="listbox" aria-expanded={picker} onClick={() => setPatternUi({ picker: !picker })}>
          <span className="ed-shape-thumb">
            <ShapeSvg points={pattern.points} compact />
          </span>
          <span className="name">{patternName(pattern, t)}</span>
          <span className="origin">{t(pattern.builtin ? 'editor.pattern.preset' : 'editor.pattern.saved')}</span>
          <ChevronDown />
        </button>
        <div className="ed-pattern-label">
          <strong>{t('editor.pattern.shape')}</strong>
          <button type="button" className="ed-btn" onClick={() => startEdit('edit')}>
            <PencilRuler />
            {t(pattern.builtin ? 'editor.pattern.editCopy' : 'editor.pattern.edit')}
          </button>
        </div>
        <div className="ed-shape" aria-label={t('editor.pattern.shapeOf', { name: patternName(pattern, t) })}>
          <ShapeSvg points={pattern.points} />
        </div>
        <div className="ed-shape-caption">
          <span>0%</span>
          <span>{t('editor.pattern.oneCycle')}</span>
          <span>100%</span>
        </div>
        {notice && (
          <div className="ed-notice" role="status">
            <Check />
            {notice}
          </div>
        )}
      </div>
      <div className="ed-pattern-foot">
        <div className="ed-apply-hd">
          <strong>{t('editor.pattern.applyTo')}</strong>
          <span>{t(AXIS_NAME[focused])}</span>
        </div>
        <div className="ed-apply-fields">
          <Select options={fillTo} value={fill.to} label={t('editor.pattern.applyRange')} onChange={(to) => setFill({ to })} />
          <Select options={heights} value={fill.height} label={t('editor.pattern.heightMode')} onChange={(height) => setFill({ height })} />
          {seconds && <span className="mono muted">{seconds} s</span>}
        </div>
        {fill.height === 'range' && (
          <div className="ed-apply-fields">
            <span className="muted">{t('editor.pattern.range')}</span>
            <NumberInput value={fill.min} min={0} max={99} label={t('editor.pattern.rangeMin')} onChange={(min) => setFill({ min: Math.min(min, fill.max - 1) })} />
            <span className="muted">{t('editor.pattern.rangeTo')}</span>
            <NumberInput value={fill.max} min={1} max={100} label={t('editor.pattern.rangeMax')} onChange={(max) => setFill({ max: Math.max(max, fill.min + 1) })} />
          </div>
        )}
        <div className="ed-apply-actions">
          <label>
            <input type="checkbox" checked={fill.replace} onChange={(ev) => setFill({ replace: ev.target.checked })} />
            {t('editor.pattern.replaceExisting')}
          </label>
          <span className="grow" />
          <Button variant="primary" onClick={() => fillPattern()}>
            {t('editor.pattern.preview')} <kbd>{keyLabel('Editor.Fill')}</kbd>
          </Button>
        </div>
      </div>
      {picker && (
        <aside ref={pickerRef} className="ed-picker" aria-label={t('editor.pattern.choose')}>
          <div className="ed-picker-hd">
            <h3>{t('editor.pattern.choose')}</h3>
            <button type="button" className="ed-btn square" aria-label={t('editor.pattern.closePicker')} title={t('common.close')} onClick={() => setPatternUi({ picker: false })}>
              <X />
            </button>
          </div>
          <label className="ed-search">
            <Search />
            <input type="search" value={search} placeholder={t('editor.pattern.search')} aria-label={t('editor.pattern.search')} autoFocus onChange={(ev) => setSearch(ev.target.value)} />
          </label>
          <div className="ed-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={group === 'mine'} className={cx(group === 'mine' && 'on')} onClick={() => setGroup('mine')}>
              {t('editor.pattern.myPatterns')}
            </button>
            <button type="button" role="tab" aria-selected={group === 'presets'} className={cx(group === 'presets' && 'on')} onClick={() => setGroup('presets')}>
              {t('editor.pattern.presets')}
            </button>
            {group === 'mine' && <span className="grow-note">{t('editor.pattern.acrossVideos')}</span>}
          </div>
          <div className="ed-pattern-list" role="listbox">
            {listed.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected={p.id === pattern.id} className={cx('ed-pattern-row', p.id === pattern.id && 'on')} onClick={() => pick(p)}>
                <span className="ed-shape-thumb">
                  <ShapeSvg points={p.points} compact />
                </span>
                <span className="name">{patternName(p, t)}</span>
                {p.id === pattern.id && <Check />}
              </button>
            ))}
            {listed.length === 0 && <div className="ed-hint">{t(group === 'mine' ? 'editor.pattern.noSaved' : 'editor.pattern.noMatch')}</div>}
          </div>
          <div className="ed-picker-foot">
            <span>{t('editor.pattern.available')}</span>
            <button type="button" className="ed-btn" onClick={() => startEdit('new')}>
              <Plus />
              {t('editor.pattern.new')}
            </button>
          </div>
        </aside>
      )}
    </section>
  )
}

import { Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { MessageKey } from '@shared/i18n'
import { refKey, refName, rowMatches, type SessionPeriod, type SessionTimeRule, type SourceRef } from '@shared/session'
import { PacingCurve } from '@/components/session/PacingCurve'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Segmented } from '@/components/ui/Segmented'
import { useT } from '@/state/i18n'
import { useSession } from '@/state/session'
import { useLibrary } from '@/state/library'
import { localHits, videoHit } from '@/session/search'
import { matchesTimeRule } from '@/session/rules'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'

export const timeText = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const MODE_LABEL: Record<SessionTimeRule['mode'], MessageKey> = { prefer: 'session.period.prefer', require: 'session.period.require' }
const KIND_LABEL: Record<SourceRef['kind'], MessageKey> = {
  folder: 'session.sourceKind.folder',
  tag: 'session.sourceKind.tag',
  section: 'session.sourceKind.section',
  playlist: 'session.sourceKind.playlist',
  video: 'session.sourceKind.video',
}

export function TimeInput({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (ms: number) => void }) {
  const [text, setText] = useState(timeText(value))
  const cancelled = useRef(false)
  useEffect(() => setText(timeText(value)), [value])
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      setText(timeText(value))
      return
    }
    const match = /^(\d+)(?::([0-5]?\d))?$/.exec(text.trim())
    if (!match) {
      setText(timeText(value))
      return
    }
    const ms = clamp((Number(match[1]) * 60 + Number(match[2] ?? 0)) * 1000, 0, max)
    setText(timeText(ms))
    onChange(ms)
  }
  return (
    <label className="session-time">
      <span>{label}</span>
      <input
        aria-label={label}
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancelled.current = true
            setText(timeText(value))
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

export function PeriodInputs({ period, totalMs, onChange }: { period: SessionPeriod; totalMs: number; onChange: (period: SessionPeriod) => void }) {
  const t = useT()
  return (
    <div className="period-inputs">
      <TimeInput label={t('session.period.from')} value={period.from * totalMs} max={Math.max(0, period.to * totalMs - 1000)} onChange={(ms) => onChange({ ...period, from: ms / totalMs })} />
      <TimeInput label={t('session.period.to')} value={period.to * totalMs} max={totalMs} onChange={(ms) => onChange({ ...period, to: Math.max(period.from + 1000 / totalMs, ms / totalMs) })} />
    </div>
  )
}

export function SessionTimeline({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const t = useT()
  const setup = useSession((s) => s.setup),
    phases = useSession((s) => s.phases),
    totalMs = useSession((s) => s.totalMs) || setup.totalMin * 60000
  const setSetup = useSession((s) => s.setSetup),
    pool = useSession((s) => s.pool),
    playlists = useSession((s) => s.playlists)
  const [draft, setDraft] = useState<SessionTimeRule | null>(null)
  const drag = useRef<{ original: SessionTimeRule; start: number; width: number; edge: 'from' | 'to' | 'move' | 'new'; current: SessionTimeRule } | null>(null)
  const rules = draft
    ? setup.timeRules.some((r) => r.id === draft.id)
      ? setup.timeRules.map((r) => (r.id === draft.id ? draft : r))
      : [...setup.timeRules, draft]
    : setup.timeRules
  const save = (rule: SessionTimeRule) => {
    setSetup({ timeRules: setup.timeRules.some((r) => r.id === rule.id) ? setup.timeRules.map((r) => (r.id === rule.id ? rule : r)) : [...setup.timeRules, rule] })
    onSelect(rule.id)
  }
  const add = () => save({ id: crypto.randomUUID(), from: 0, to: 0.25, mode: 'prefer', match: 'any', refs: [] })
  const begin = (e: PointerEvent<HTMLElement>, rule: SessionTimeRule | null, edge: 'from' | 'to' | 'move' | 'new') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const lane = e.currentTarget.closest<HTMLElement>('.timeline-lane') ?? e.currentTarget
    const rect = lane.getBoundingClientRect()
    const p = clamp((Math.round((((e.clientX - rect.left) / rect.width) * totalMs) / 1000) * 1000) / totalMs, 0, 1 - 1000 / totalMs)
    const original = rule ?? { id: crypto.randomUUID(), from: p, to: Math.min(1, p + 1000 / totalMs), mode: 'prefer', match: 'any', refs: [] }
    drag.current = { original, current: original, start: e.clientX, width: rect.width, edge }
    setDraft(original)
    onSelect(original.id)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const delta = (Math.round((((e.clientX - d.start) / d.width) * totalMs) / 1000) * 1000) / totalMs
    const gap = 1000 / totalMs,
      r = d.original
    let from = r.from,
      to = r.to
    if (d.edge === 'move') {
      from = clamp(r.from + delta, 0, 1 - (r.to - r.from))
      to = from + r.to - r.from
    } else if (d.edge === 'from') from = clamp(r.from + delta, 0, r.to - gap)
    else if (d.edge === 'to') to = clamp(r.to + delta, r.from + gap, 1)
    else {
      from = clamp(Math.min(r.from, r.from + delta), 0, 1 - gap)
      to = clamp(Math.max(r.from + gap, r.from + delta), from + gap, 1)
    }
    d.current = { ...r, from, to }
    setDraft(d.current)
  }
  const finish = () => {
    if (drag.current) save(drag.current.current)
    drag.current = null
    setDraft(null)
  }
  return (
    <section className="session-timeline">
      <div className="timeline-heading">
        <h2>{t('session.timeline.title')}</h2>
        <Button variant="ghost" onClick={add}>
          <Plus />
          {t('session.timeline.addPeriod')}
        </Button>
      </div>
      <div className="timeline-axis">
        <div className="intensity-labels">
          <span>{t('session.timeline.high')}</span>
          <span>{t('session.timeline.low')}</span>
        </div>
        <div className="timeline-plot">
          <PacingCurve phases={phases} totalMs={totalMs} height={140} />
          <div className="timeline-grid" />
          {rules.map((r) => (
            <span key={r.id} className={cx('timeline-shade', selected === r.id && 'selected')} style={{ left: `${r.from * 100}%`, width: `${(r.to - r.from) * 100}%` }} />
          ))}
        </div>
      </div>
      <div className="timeline-ruler">
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <span key={p}>{timeText(totalMs * p)}</span>
        ))}
      </div>
      <div
        className="timeline-tracks"
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={() => {
          drag.current = null
          setDraft(null)
        }}
      >
        {rules.map((r, i) => {
          const count = pool.filter((row) => matchesTimeRule(row, r, playlists)).length
          return (
            <div className="timeline-lane" key={r.id}>
              <div
                className={cx('timeline-period', selected === r.id && 'selected', r.mode, count === 0 && 'empty')}
                style={{ left: `${r.from * 100}%`, width: `${(r.to - r.from) * 100}%`, '--period-tint': ['#b8a0f4', '#72c4b5', '#e7b982'][i % 3] } as React.CSSProperties}
              >
                {(['from', 'to'] as const).map((edge) => (
                  <button
                    key={edge}
                    className={`period-handle ${edge}`}
                    aria-label={t(edge === 'from' ? 'session.timeline.periodStart' : 'session.timeline.periodEnd', { n: i + 1 })}
                    title={t('session.timeline.handleTitle')}
                    onPointerDown={(e) => begin(e, r, edge)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                      e.preventDefault()
                      const delta = ((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) * 1000) / totalMs
                      save({ ...r, [edge]: edge === 'from' ? clamp(r.from + delta, 0, r.to - 1000 / totalMs) : clamp(r.to + delta, r.from + 1000 / totalMs, 1) })
                    }}
                  />
                ))}
                <button
                  className="period-body"
                  onClick={() => onSelect(r.id)}
                  onPointerDown={(e) => begin(e, r, 'move')}
                  title={t('session.timeline.periodTitle', {
                    from: timeText(r.from * totalMs),
                    to: timeText(r.to * totalMs),
                    mode: t(MODE_LABEL[r.mode]),
                    sources: r.refs.map((ref) => refName(ref, t)).join(', ') || t('session.timeline.selection'),
                    videos: t('session.count.videos', { count }),
                  })}
                >
                  <b>{r.refs.map((ref) => refName(ref, t)).join(', ') || t('session.footer.chooseSources')}</b>
                  <span>{t('session.timeline.modeCount', { mode: t(MODE_LABEL[r.mode]), count })}</span>
                </button>
              </div>
            </div>
          )
        })}
        <div className="timeline-lane timeline-add" onPointerDown={(e) => begin(e, null, 'new')}>
          <span>{t('session.timeline.dragToAdd')}</span>
        </div>
      </div>
      {setup.totalMin !== setup.totalMax && <p className="session-hint">{t('session.timeline.scaleHint', { time: timeText(totalMs) })}</p>}
    </section>
  )
}

export function PeriodEditor({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const t = useT()
  const setup = useSession((s) => s.setup),
    totalMs = useSession((s) => s.totalMs) || setup.totalMin * 60000
  const setSetup = useSession((s) => s.setSetup),
    pool = useSession((s) => s.pool),
    playlists = useSession((s) => s.playlists),
    issues = useSession((s) => s.issues)
  const rule = setup.timeRules.find((r) => r.id === selected)
  if (!rule)
    return (
      <aside className="period-editor empty-editor">
        <h2>{t('session.period.emptyTitle')}</h2>
        <p>{t('session.period.emptyHint')}</p>
        <Button
          onClick={() => {
            const id = crypto.randomUUID()
            setSetup({ timeRules: [...setup.timeRules, { id, from: 0, to: 0.25, mode: 'prefer', match: 'any', refs: [] }] })
            onSelect(id)
          }}
        >
          <Plus />
          {t('session.timeline.addPeriod')}
        </Button>
      </aside>
    )
  const update = (patch: Partial<SessionTimeRule>) => setSetup({ timeRules: setup.timeRules.map((r) => (r.id === rule.id ? { ...r, ...patch } : r)) })
  const count = pool.filter((row) => matchesTimeRule(row, rule, playlists)).length
  const conflict = issues.some((i) => i.kind === 'required' && i.from < rule.to && i.to > rule.from)
  return (
    <aside className="period-editor">
      <div className="editor-heading">
        <h2>{t('session.period.title')}</h2>
        <IconButton label={t('session.period.close')} onClick={() => onSelect(null)}>
          <X />
        </IconButton>
      </div>
      <PeriodInputs period={rule} totalMs={totalMs} onChange={update} />
      <Segmented
        label={t('session.period.selectionRule')}
        options={[
          { value: 'prefer', label: t('session.period.prefer') },
          { value: 'require', label: t('session.period.require') },
        ]}
        value={rule.mode}
        onChange={(mode) => update({ mode })}
      />
      <p className="session-hint">{rule.mode === 'prefer' ? t('session.period.preferHint') : t('session.period.requireHint')}</p>
      <div className="period-chips">
        {rule.refs.map((ref) => (
          <span className="period-chip" key={refKey(ref)}>
            {refName(ref, t)}
            <IconButton size="sm" label={t('session.period.removeRef', { name: refName(ref, t) })} onClick={() => update({ refs: rule.refs.filter((r) => refKey(r) !== refKey(ref)) })}>
              <X />
            </IconButton>
          </span>
        ))}
      </div>
      <PeriodSourcePicker refs={rule.refs} onAdd={(ref) => update({ refs: [...rule.refs, ref] })} />
      {rule.refs.length > 1 && (
        <Segmented
          label={t('session.period.matchSources')}
          options={[
            { value: 'any', label: t('session.period.matchAny') },
            { value: 'all', label: t('session.period.matchAll') },
          ]}
          value={rule.match}
          onChange={(match) => update({ match })}
        />
      )}
      <div className={cx('period-count', (conflict || !count) && 'empty')} aria-live="polite">
        <strong>{count}</strong>
        <span>{t('session.period.ofQualify', { count: pool.length })}</span>
      </div>
      {conflict && <p className="session-error">{count === 0 ? t('session.period.noRequiredMatches') : t('session.period.noOverlapMatches')}</p>}
      {!rule.refs.length && <p className="session-hint">{t('session.period.chooseSources')}</p>}
      {rule.mode === 'prefer' && count === 0 && <p className="session-hint">{t('session.period.noPreferMatches')}</p>}
      <p className="session-hint">{t('session.period.countsHint')}</p>
      <Button
        variant="ghost"
        onClick={() => {
          setSetup({ timeRules: setup.timeRules.filter((r) => r.id !== rule.id) })
          onSelect(null)
        }}
      >
        <Trash2 />
        {t('session.period.remove')}
      </Button>
    </aside>
  )
}

function PeriodSourcePicker({ refs, onAdd }: { refs: SourceRef[]; onAdd: (ref: SourceRef) => void }) {
  const t = useT()
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false)
  const folders = useLibrary((s) => s.folders),
    tags = useLibrary((s) => s.tags),
    libraryPlaylists = useLibrary((s) => s.playlists),
    counts = useLibrary((s) => s.counts)
  const pool = useSession((s) => s.pool),
    known = useSession((s) => s.playlists)
  const [members, setMembers] = useState(new Map<number, Set<number>>()),
    [error, setError] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.all(
      libraryPlaylists.map(
        async (p) => [p.id, new Set(await invoke('library:queryIds', { section: 'all', sort: 'added', desc: false, filters: {}, playlistId: p.id, limit: 0, offset: 0 }))] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled) {
          setMembers(new Map(entries))
          setError(false)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, libraryPlaylists])
  const hits = useMemo(() => {
    const selected = new Set(refs.map(refKey)),
      playlists = new Map([...known, ...members])
    return [
      ...localHits(query, folders, tags, libraryPlaylists, counts, t),
      ...pool
        .filter((row) => query.trim() && row.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 20)
        .map(videoHit),
    ]
      .filter((h) => !selected.has(refKey(h.ref)))
      .map((h) => ({ ...h, count: h.ref.kind === 'playlist' && !playlists.has(h.ref.id) ? null : pool.filter((row) => rowMatches(row, h.ref, playlists)).length }))
      .sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
      .slice(0, 40)
  }, [refs, known, members, query, folders, tags, libraryPlaylists, counts, pool, t])
  return (
    <div className="period-picker">
      <input
        aria-label={t('session.period.findSources')}
        placeholder={t('session.period.findPlaceholder')}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && (
        <div className="period-results">
          <div className="period-results-heading">
            <span>{t('session.period.withinSelection')}</span>
            <IconButton label={t('session.period.closeSources')} size="sm" onClick={() => setOpen(false)}>
              <X />
            </IconButton>
          </div>
          {error && <p className="session-error">{t('session.period.countError')}</p>}
          {hits.map((h) => (
            <button
              key={refKey(h.ref)}
              disabled={h.count === 0 || h.count === null}
              onClick={() => {
                onAdd(h.ref)
                setOpen(false)
                setQuery('')
              }}
            >
              <span>
                <b>{refName(h.ref, t)}</b>
                <small>{t(KIND_LABEL[h.ref.kind])}</small>
              </span>
              <span>{h.count ?? '…'}</span>
            </button>
          ))}
          {!hits.length && <p className="session-hint">{t('session.period.noSources')}</p>}
        </div>
      )}
    </div>
  )
}

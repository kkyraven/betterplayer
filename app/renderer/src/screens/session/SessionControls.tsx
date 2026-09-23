import { Film, Folder, Layers, ListVideo, Plus, Search, Tag, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RULE_AXES } from '@shared/axes'
import type { MessageKey } from '@shared/i18n'
import type { FolderNode, MediaRow } from '@shared/library'
import { isPlaylist } from '@shared/library'
import { CLIP_MAX_S, CLIP_MIN_S, ENTRY_ROLES, refKey, refName, type EntryRole, type PacingSettings, type SessionEntry, type SourceRef } from '@shared/session'
import { AxisChips } from '@/components/media/AxisChips'
import { AxisToggles } from '@/components/media/AxisToggles'
import { ThumbnailImage } from '@/components/media/ThumbnailImage'
import { HeatStrip } from '@/components/media/HeatStrip'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { invoke } from '@/ipc'
import { localHits, videoHit, type SourceHit } from '@/session/search'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSession, type Clip } from '@/state/session'
import './session.css'

const KIND_ICON = { folder: Folder, tag: Tag, section: Layers, playlist: ListVideo, video: Film } as const
const ROLE_LABEL: Record<EntryRole, MessageKey> = { include: 'session.role.include', modify: 'session.role.modify', exclude: 'session.role.exclude' }
const LOCAL_HITS_MAX = 8
const VIDEO_HITS_MAX = 6

const fmtSeconds = (s: number) => (s < 60 ? `${s} s` : fmtDuration(s * 1000))
const pct = (v: number) => Math.round(v * 100)

export function Sources() {
  const t = useT()
  const entries = useSession((s) => s.setup.entries)
  return (
    <aside className="src">
      <h2>{t('session.sources.title')}</h2>
      <SourceSearch />
      <SelectionCount />
      <div>
        <div className="eyebrow">{t('session.sources.eyebrow')}</div>
        <div className="list">
          {entries.map((e) => (
            <EntryRow key={refKey(e.ref)} entry={e} />
          ))}
        </div>
      </div>
    </aside>
  )
}

function SourceSearch() {
  const t = useT()
  const folders = useLibrary((s) => s.folders)
  const tags = useLibrary((s) => s.tags)
  const playlists = useLibrary((s) => s.playlists)
  const counts = useLibrary((s) => s.counts)
  const entries = useSession((s) => s.setup.entries)
  const addEntry = useSession((s) => s.addEntry)
  const [query, setQuery] = useState('')
  const [videos, setVideos] = useState<SourceHit[]>([])
  const [active, setActive] = useState(0)
  const timer = useRef(0)
  const present = useMemo(() => new Set(entries.map((e) => refKey(e.ref))), [entries])
  const hits = useMemo(() => {
    if (!query.trim()) return []
    const local = localHits(query, folders, tags, playlists, counts, t).slice(0, LOCAL_HITS_MAX)
    return [...local, ...videos].filter((h) => !present.has(refKey(h.ref)))
  }, [query, folders, tags, playlists, counts, videos, present, t])

  useEffect(() => {
    window.clearTimeout(timer.current)
    const q = query.trim()
    if (!q) {
      setVideos([])
      return
    }
    timer.current = window.setTimeout(() => {
      void invoke('library:query', { section: 'all', search: q, sort: 'name', desc: false, filters: {}, limit: VIDEO_HITS_MAX, offset: 0 }).then((page) =>
        setVideos(page.rows.filter((e): e is MediaRow => !isPlaylist(e)).map(videoHit)),
      )
    }, 150)
    return () => window.clearTimeout(timer.current)
  }, [query])
  useEffect(() => setActive(0), [hits.length, query])

  const add = (hit: SourceHit | undefined) => {
    if (!hit) return
    addEntry(hit.ref)
    setQuery('')
  }
  return (
    <div className="search">
      <Search />
      <input
        placeholder={t('session.sources.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add(hits[active])
          else if (e.key === 'ArrowDown') setActive((a) => Math.min(hits.length - 1, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Escape') {
            setQuery('')
            e.currentTarget.blur()
          } else return
          e.preventDefault()
        }}
      />
      {hits.length > 0 && (
        <div className="results" role="listbox">
          {hits.map((h, i) => {
            const Icon = KIND_ICON[h.ref.kind]
            const sub = h.ref.kind === 'video' ? h.sub || t('session.rootFolder') : h.sub
            return (
              <button
                key={refKey(h.ref)}
                type="button"
                role="option"
                aria-selected={i === active}
                className={cx('hit', i === active && 'hl')}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(h)}
              >
                <Icon />
                <span className="name">{refName(h.ref, t)}</span>
                {sub && <span className="sub">{sub}</span>}
                <span className="spacer" />
                {h.count !== null && <span className="n">{h.count}</span>}
                <Plus />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function findFolder(nodes: FolderNode[], rootId: number, folder: string): FolderNode | undefined {
  for (const n of nodes) {
    if (n.rootId === rootId && n.folder === folder) return n
    const hit = findFolder(n.children, rootId, folder)
    if (hit) return hit
  }
  return undefined
}

function useRefCount(ref: SourceRef): number | null {
  const folders = useLibrary((s) => s.folders)
  const tags = useLibrary((s) => s.tags)
  const playlists = useLibrary((s) => s.playlists)
  const counts = useLibrary((s) => s.counts)
  switch (ref.kind) {
    case 'folder':
      return findFolder(folders, ref.rootId, ref.folder)?.count ?? null
    case 'tag':
      return tags.find((t) => t.name === ref.name)?.count ?? null
    case 'section':
      return counts[ref.section]
    case 'playlist':
      return playlists.find((p) => p.id === ref.id)?.count ?? null
    case 'video':
      return null
  }
}

function EntryRow({ entry }: { entry: SessionEntry }) {
  const t = useT()
  const removeEntry = useSession((s) => s.removeEntry)
  const count = useRefCount(entry.ref)
  const Icon = KIND_ICON[entry.ref.kind]
  const key = refKey(entry.ref)
  const badges: string[] = []
  if (entry.clipMinS !== undefined && entry.clipMaxS !== undefined) badges.push(t('session.range', { min: fmtSeconds(entry.clipMinS), max: fmtSeconds(entry.clipMaxS) }))
  if (entry.axesOff?.length) badges.push(t('session.entry.axesOff', { axes: entry.axesOff.join(' ') }))
  if (entry.chance) badges.push(t('session.entry.chance', { percent: `${entry.chance.percent > 0 ? '+' : ''}${entry.chance.percent}`, from: pct(entry.chance.from), to: pct(entry.chance.to) }))
  return (
    <div className={cx('entry', entry.role)}>
      <Sheet
        title={refName(entry.ref, t)}
        align="start"
        width={380}
        trigger={
          <button type="button" className="entry-main">
            <Icon />
            <span className="name">{refName(entry.ref, t)}</span>
            {count !== null && <span className="n">{count}</span>}
            {badges.map((b) => (
              <span key={b} className="rule">
                {b}
              </span>
            ))}
            <span className="spacer" />
            <span className={cx('role', entry.role)}>{t(ROLE_LABEL[entry.role])}</span>
          </button>
        }
      >
        <EntryRules entry={entry} />
      </Sheet>
      <IconButton label={t('common.remove')} size="sm" onClick={() => removeEntry(key)}>
        <X />
      </IconButton>
    </div>
  )
}

function EntryRules({ entry }: { entry: SessionEntry }) {
  const t = useT()
  const setup = useSession((s) => s.setup)
  const updateEntry = useSession((s) => s.updateEntry)
  const key = refKey(entry.ref)
  const ownClip = entry.clipMinS !== undefined && entry.clipMaxS !== undefined
  const axesOff = entry.axesOff ?? []
  const chance = entry.chance ?? { percent: 0, from: 0, to: 1 }
  const setChance = (patch: Partial<typeof chance>) => {
    const next = { ...chance, ...patch }
    updateEntry(key, { chance: next.percent === 0 ? undefined : next })
  }
  const hasRules = ownClip || axesOff.length > 0 || entry.chance !== undefined
  const roleOptions = ENTRY_ROLES.map((value) => ({ value, label: t(ROLE_LABEL[value]) }))
  return (
    <>
      <div className="rule-row">
        <span>{t('session.entry.role')}</span>
        <Segmented options={roleOptions} value={entry.role} onChange={(role) => updateEntry(key, { role })} label={t('session.entry.role')} />
      </div>
      <div className="rule-row">
        <span>{t('session.entry.clipLength')}</span>
        <div>
          <Switch
            checked={ownClip}
            label={t('session.entry.ownClipLength')}
            onCheckedChange={(on) => updateEntry(key, on ? { clipMinS: setup.clipMinS, clipMaxS: setup.clipMaxS } : { clipMinS: undefined, clipMaxS: undefined })}
          />
          {ownClip ? (
            <>
              <NumberInput
                value={entry.clipMinS ?? setup.clipMinS}
                min={CLIP_MIN_S}
                max={entry.clipMaxS ?? CLIP_MAX_S}
                unit="s"
                label={t('session.entry.clipMinimum')}
                onChange={(clipMinS) => updateEntry(key, { clipMinS })}
              />
              <span className="faint">{t('session.entry.to')}</span>
              <NumberInput
                value={entry.clipMaxS ?? setup.clipMaxS}
                min={entry.clipMinS ?? CLIP_MIN_S}
                max={CLIP_MAX_S}
                unit="s"
                label={t('session.entry.clipMaximum')}
                onChange={(clipMaxS) => updateEntry(key, { clipMaxS })}
              />
            </>
          ) : (
            <span className="faint">{t('session.range', { min: fmtSeconds(setup.clipMinS), max: fmtSeconds(setup.clipMaxS) })}</span>
          )}
        </div>
      </div>
      <div className="rule-row">
        <span>{t('session.entry.axes')}</span>
        <AxisToggles axes={RULE_AXES} on={axesOff} variant="off" onChange={(next) => updateEntry(key, { axesOff: next.length ? next : undefined })} />
      </div>
      <div className="rule-row">
        <span>{t('session.entry.chanceLabel')}</span>
        <div>
          <NumberInput value={chance.percent} min={-100} max={900} unit="%" label={t('session.entry.chanceChange')} onChange={(percent) => setChance({ percent })} />
          <span className="faint">{t('session.entry.from')}</span>
          <NumberInput value={pct(chance.from)} min={0} max={pct(chance.to)} unit="%" label={t('session.entry.chanceFrom')} onChange={(v) => setChance({ from: v / 100 })} />
          <span className="faint">{t('session.entry.to')}</span>
          <NumberInput value={pct(chance.to)} min={pct(chance.from)} max={100} unit="%" label={t('session.entry.chanceTo')} onChange={(v) => setChance({ to: v / 100 })} />
        </div>
      </div>
      <div className="rule-ft">
        <span className="faint">{t('session.entry.axesHint')}</span>
        <Button variant="ghost" disabled={!hasRules} onClick={() => updateEntry(key, { clipMinS: undefined, clipMaxS: undefined, axesOff: undefined, chance: undefined })}>
          {t('session.entry.clearRules')}
        </Button>
      </div>
    </>
  )
}

export function PacingParams({ pacing, onChange }: { pacing: PacingSettings; onChange: (patch: Partial<PacingSettings>) => void }) {
  const t = useT()
  const range = (value: [number, number], label: string, set: (r: [number, number]) => void) => (
    <>
      <NumberInput value={value[0]} min={1} max={value[1]} unit="s" label={t('session.pacingParams.minimumOf', { name: label })} onChange={(v) => set([v, value[1]])} />
      <span className="faint">{t('session.pacingParams.to')}</span>
      <NumberInput value={value[1]} min={value[0]} max={3600} unit="s" label={t('session.pacingParams.maximumOf', { name: label })} onChange={(v) => set([value[0], v])} />
    </>
  )
  const level = (value: number, label: string, set: (v: number) => void) => (
    <NumberInput value={pct(value)} min={0} max={100} unit="%" label={label} onChange={(v) => set(v / 100)} />
  )
  switch (pacing.kind) {
    case 'random':
      return <p className="params faint">{t('session.pacingParams.randomHint')}</p>
    case 'busy':
      return <p className="params faint">{t('session.pacingParams.busyHint')}</p>
    case 'rlgl': {
      const p = pacing.rlgl
      const set = (patch: Partial<typeof p>) => onChange({ rlgl: { ...p, ...patch } })
      const green = t('session.pacingParams.green'),
        red = t('session.pacingParams.red')
      return (
        <>
          <div className="params">
            <b>{green}</b>
            {range(p.fastS, green, (fastS) => set({ fastS }))}
            <span className="faint">{t('session.entry.at')}</span>
            {level(p.fast, t('session.pacingParams.intensityOf', { name: green }), (fast) => set({ fast }))}
          </div>
          <div className="params">
            <b>{red}</b>
            {range(p.slowS, red, (slowS) => set({ slowS }))}
            <span className="faint">{t('session.entry.at')}</span>
            {level(p.slow, t('session.pacingParams.intensityOf', { name: red }), (slow) => set({ slow }))}
          </div>
        </>
      )
    }
    case 'ramp': {
      const p = pacing.ramp
      return (
        <div className="params">
          <b>{t('session.pacingParams.from')}</b>
          {level(p.from, t('session.pacingParams.rampStart'), (from) => onChange({ ramp: { ...p, from } }))}
          <b>{t('session.pacingParams.to')}</b>
          {level(p.to, t('session.pacingParams.rampEnd'), (to) => onChange({ ramp: { ...p, to } }))}
        </div>
      )
    }
    case 'waves': {
      const p = pacing.waves
      const set = (patch: Partial<typeof p>) => onChange({ waves: { ...p, ...patch } })
      return (
        <div className="params">
          <b>{t('session.pacingParams.period')}</b>
          {range(p.periodS, t('session.pacingParams.period'), (periodS) => set({ periodS }))}
          <b>{t('session.pacingParams.low')}</b>
          {level(p.low, t('session.pacingParams.waveLow'), (low) => set({ low }))}
          <b>{t('session.pacingParams.high')}</b>
          {level(p.high, t('session.pacingParams.waveHigh'), (high) => set({ high }))}
        </div>
      )
    }
    case 'custom': {
      const p = pacing.custom
      const setSteps = (steps: typeof p.steps) => onChange({ custom: { ...p, steps } })
      return (
        <>
          {p.steps.map((step, i) => (
            <div className="params" key={i}>
              <b>{i + 1}</b>
              {range(step.lengthS, t('session.pacingParams.step', { n: i + 1 }), (lengthS) => setSteps(p.steps.map((s, j) => (j === i ? { ...s, lengthS } : s))))}
              <span className="faint">{t('session.entry.at')}</span>
              {level(step.intensity, t('session.pacingParams.intensityOf', { name: t('session.pacingParams.step', { n: i + 1 }) }), (intensity) => setSteps(p.steps.map((s, j) => (j === i ? { ...s, intensity } : s))))}
              <IconButton label={t('session.pacingParams.removeStep')} size="sm" disabled={p.steps.length <= 1} onClick={() => setSteps(p.steps.filter((_, j) => j !== i))}>
                <X />
              </IconButton>
            </div>
          ))}
          <div className="params">
            <Button variant="ghost" onClick={() => setSteps([...p.steps, { lengthS: [30, 60], intensity: 0.5 }])}>
              <Plus />
              {t('session.pacingParams.addStep')}
            </Button>
            <span className="spacer" />
            <label className="opt">
              <span>{t('session.pacingParams.repeat')}</span>
              <Switch checked={p.repeat} label={t('session.pacingParams.repeatSteps')} onCheckedChange={(repeat) => onChange({ custom: { ...p, repeat } })} />
            </label>
          </div>
        </>
      )
    }
  }
}

export function ClipRow({ clip, n, action }: { clip: Clip; n: number; action?: React.ReactNode }) {
  const t = useT()
  const { row } = clip
  const left = row.durationMs > 0 ? (clip.startMs / row.durationMs) * 100 : 0
  const width = row.durationMs > 0 ? ((clip.endMs - clip.startMs) / row.durationMs) * 100 : 0
  return (
    <div className="prow2">
      <span className="n">{n}</span>
      <div className="th">
        {row.thumb && <ThumbnailImage src={row.thumb} alt="" draggable={false} />}
        <div className="clip" style={{ left: `${left}%`, width: `${width}%` }} />
        <HeatStrip heat={row.heat} className="th-heat" />
      </div>
      <div className="t">
        <b>{row.title}</b>
        <span>{row.folder || t('session.rootFolder')}</span>
      </div>
      <span className="range">{t('session.range', { min: fmtDuration(clip.startMs), max: fmtDuration(clip.endMs) })}</span>
      <AxisChips axes={row.axes} />
      <span className="d">{action ?? fmtDuration(clip.endMs - clip.startMs)}</span>
    </div>
  )
}

function SelectionCount() {
  const t = useT()
  const count = useSession((s) => s.pool.length)
  const loading = useSession((s) => s.loading)
  return (
    <div className="selection-count">
      <b>{loading ? '…' : count.toLocaleString()}</b> {t('session.sources.qualifying')}
    </div>
  )
}

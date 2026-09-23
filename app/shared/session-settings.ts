import { createTranslator, ENGLISH, type Translate } from './i18n'
import { isAxisId, type AxisId } from './axes'
import { defaultSessionSetup, PACING_KINDS, refKey, type SessionRun, type SessionSetup, type SourceRef } from './session'
import { SECTIONS } from './library'

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const axisIds = (value: unknown): AxisId[] => list(value).filter((a): a is AxisId => typeof a === 'string' && isAxisId(a))

function source(value: unknown): SourceRef | null {
  if (!object(value)) return null
  switch (value.kind) {
    case 'folder':
      return typeof value.rootId === 'number' && typeof value.folder === 'string' && typeof value.name === 'string'
        ? { kind: 'folder', rootId: value.rootId, folder: value.folder, name: value.name }
        : null
    case 'tag':
      return typeof value.name === 'string' ? { kind: 'tag', name: value.name } : null
    case 'section':
      return SECTIONS.find((s) => s === value.section) ? { kind: 'section', section: SECTIONS.find((s) => s === value.section)! } : null
    case 'playlist':
      return typeof value.id === 'number' && typeof value.name === 'string' ? { kind: 'playlist', id: value.id, name: value.name } : null
    case 'video':
      return typeof value.id === 'number' && typeof value.title === 'string' ? { kind: 'video', id: value.id, title: value.title } : null
    default:
      return null
  }
}

export function sessionSetup(value: unknown, t: Translate = createTranslator('en', ENGLISH)): SessionSetup {
  const d = defaultSessionSetup()
  if (!object(value)) return d
  const pacing = object(value.pacing) ? value.pacing : {}
  const ramp = object(pacing.ramp) ? pacing.ramp : {}
  const waves = object(pacing.waves) ? pacing.waves : {}
  const rlgl = object(pacing.rlgl) ? pacing.rlgl : {}
  const custom = object(pacing.custom) ? pacing.custom : {}
  const toys = object(value.toys) ? value.toys : {}
  const range = (value: unknown, fallback: [number, number]): [number, number] => {
    const input = list(value)
    const min = finite(input[0], fallback[0], 1, 3600)
    return [min, finite(input[1], fallback[1], min, 3600)]
  }
  const period = (value: Record<string, unknown>) => {
    const from = finite(value.from, 0, 0, 0.9999)
    return { from, to: finite(value.to, 1, from + 0.0001, 1) }
  }
  const totalMin = finite(value.totalMin, d.totalMin, 1, 600)
  const clipMinS = finite(value.clipMinS, d.clipMinS, 1, 900)
  const entries = list(value.entries)
    .filter(object)
    .flatMap((e) => {
      const ref = source(e.ref)
      if (!ref) return []
      const role = e.role === 'exclude' || e.role === 'modify' ? e.role : 'include'
      const min = typeof e.clipMinS === 'number' ? finite(e.clipMinS, clipMinS, 1, 900) : undefined
      return [
        {
          ref,
          role,
          clipMinS: min,
          clipMaxS: min === undefined ? undefined : finite(e.clipMaxS, min, min, 900),
          axesOff: axisIds(e.axesOff),
          chance: object(e.chance) ? { ...period(e.chance), percent: finite(e.chance.percent, 0, -100, 900) } : undefined,
        } satisfies SessionSetup['entries'][number],
      ]
    })
  const low = finite(toys.low, d.toys.low, 0, 0.99)
  return {
    entries: Array.isArray(value.entries) ? entries.filter((e, i) => entries.findIndex((other) => refKey(e.ref) === refKey(other.ref)) === i) : d.entries,
    totalMin,
    totalMax: finite(value.totalMax, d.totalMax, totalMin, 600),
    clipMinS,
    clipMaxS: finite(value.clipMaxS, d.clipMaxS, clipMinS, 900),
    pacing: {
      kind: PACING_KINDS.find((k) => k === pacing.kind) ?? d.pacing.kind,
      ramp: { from: finite(ramp.from, d.pacing.ramp.from, 0, 1), to: finite(ramp.to, d.pacing.ramp.to, 0, 1) },
      waves: { periodS: range(waves.periodS, d.pacing.waves.periodS), low: finite(waves.low, d.pacing.waves.low, 0, 1), high: finite(waves.high, d.pacing.waves.high, 0, 1) },
      rlgl: {
        fastS: range(rlgl.fastS, d.pacing.rlgl.fastS),
        slowS: range(rlgl.slowS, d.pacing.rlgl.slowS),
        fast: finite(rlgl.fast, d.pacing.rlgl.fast, 0, 1),
        slow: finite(rlgl.slow, d.pacing.rlgl.slow, 0, 1),
      },
      custom: {
        repeat: flag(custom.repeat, d.pacing.custom.repeat),
        steps: Array.isArray(custom.steps)
          ? custom.steps
              .filter(object)
              .slice(0, 100)
              .map((s) => ({ lengthS: range(s.lengthS, [30, 60]), intensity: finite(s.intensity, 0.5, 0, 1) }))
          : d.pacing.custom.steps,
      },
    },
    matchVideos: flag(value.matchVideos, true),
    timeRules: list(value.timeRules)
      .filter(object)
      .slice(0, 100)
      .map((rule, i) => ({
        id: typeof rule.id === 'string' ? rule.id : `period-${i}`,
        ...period(rule),
        mode: rule.mode === 'require' ? 'require' : 'prefer',
        match: rule.match === 'all' ? 'all' : 'any',
        refs: list(rule.refs)
          .map(source)
          .filter((ref): ref is SourceRef => ref !== null),
      })),
    toys: {
      enabled: flag(toys.enabled, false),
      low,
      high: finite(toys.high, d.toys.high, low + 0.01, 1),
      rules: list(toys.rules)
        .filter(object)
        .filter((r) => typeof r.outputId === 'string')
        .map((r) => ({
          outputId: String(r.outputId),
          name: typeof r.name === 'string' ? r.name : t('session.toys.toy'),
          low: finite(r.low, 1, 0, 1),
          middle: finite(r.middle, 1, 0, 1),
          high: finite(r.high, 1, 0, 1),
        })),
      periods: list(toys.periods)
        .filter(object)
        .filter((r) => typeof r.outputId === 'string')
        .slice(0, 100)
        .map((r, i) => ({
          id: typeof r.id === 'string' ? r.id : `toy-period-${i}`,
          outputId: String(r.outputId),
          name: typeof r.name === 'string' ? r.name : t('session.toys.toy'),
          ...period(r),
          scale: finite(r.scale, 1, 0, 1),
        })),
    },
    tracking: flag(value.tracking, d.tracking),
    showTimes: flag(value.showTimes, d.showTimes),
    scriptedOnly: flag(value.scriptedOnly, d.scriptedOnly),
    requireAxes: axisIds(value.requireAxes),
    skipLastSessions: Math.floor(finite(value.skipLastSessions, 0, 0, 50)),
    skipLastWatched: Math.floor(finite(value.skipLastWatched, 0, 0, 500)),
  }
}

export function sessionRun(value: unknown, t: Translate = createTranslator('en', ENGLISH)): SessionRun | null {
  if (
    !object(value) ||
    !object(value.setup) ||
    !Array.isArray(value.clips) ||
    !Array.isArray(value.phases) ||
    value.clips.length > 1000 ||
    !value.clips.length ||
    value.phases.length > 5000
  )
    return null
  const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const intensity = (v: unknown): v is number | null => v === null || (numeric(v) && v >= 0 && v <= 1)
  if (!numeric(value.totalMs) || value.totalMs <= 0 || value.totalMs > 36_000_000) return null
  const clips: SessionRun['clips'] = []
  for (const clip of value.clips) {
    if (
      !object(clip) ||
      !numeric(clip.mediaId) ||
      !Number.isInteger(clip.mediaId) ||
      !numeric(clip.startMs) ||
      !numeric(clip.endMs) ||
      clip.startMs < 0 ||
      clip.endMs <= clip.startMs ||
      !numeric(clip.phase) ||
      !Number.isInteger(clip.phase) ||
      clip.phase < 0 ||
      clip.phase >= value.phases.length ||
      !intensity(clip.intensity)
    )
      return null
    clips.push({
      mediaId: clip.mediaId,
      title: typeof clip.title === 'string' ? clip.title : t('player.queue.video'),
      startMs: clip.startMs,
      endMs: clip.endMs,
      intensity: clip.intensity,
      axesOff: axisIds(clip.axesOff),
      phase: clip.phase,
    })
  }
  const phases: SessionRun['phases'] = []
  for (const phase of value.phases) {
    if (
      !object(phase) ||
      !numeric(phase.startMs) ||
      !numeric(phase.endMs) ||
      phase.startMs < 0 ||
      phase.endMs <= phase.startMs ||
      phase.endMs > value.totalMs ||
      phase.startMs !== (phases.at(-1)?.endMs ?? 0) ||
      !intensity(phase.from) ||
      !intensity(phase.to)
    )
      return null
    phases.push({
      startMs: phase.startMs,
      endMs: phase.endMs,
      from: phase.from,
      to: phase.to,
      hard: flag(phase.hard, false),
      label: typeof phase.label === 'string' ? phase.label : t('session.settings.pacing'),
    })
  }
  if (!phases.length || phases.at(-1)?.endMs !== value.totalMs || Math.abs(clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0) - value.totalMs) > 1) return null
  return { setup: sessionSetup(value.setup, t), clips, phases, totalMs: value.totalMs }
}

import type { MediaRow } from '@shared/library'
import { rowMatches, type SessionSetup, type SessionTimeRule, type SessionToySettings } from '@shared/session'

export type PlaylistMembers = ReadonlyMap<number, ReadonlySet<number>>

export interface SessionIssue {
  kind: 'empty' | 'required' | 'toy-overlap' | 'length'
  ruleId?: string
  from: number
  to: number
}

export function eligibleVideos(candidates: MediaRow[], setup: SessionSetup, playlists: PlaylistMembers, skip: ReadonlySet<number>): MediaRow[] {
  return candidates.filter(
    (row) =>
      row.durationMs >= 1000 &&
      !skip.has(row.id) &&
      (!setup.scriptedOnly || row.axes.length > 0) &&
      setup.requireAxes.every((axis) => row.axes.includes(axis)) &&
      !setup.entries.some((e) => e.role === 'exclude' && rowMatches(row, e.ref, playlists)),
  )
}

export function matchesTimeRule(row: MediaRow, rule: SessionTimeRule, playlists: PlaylistMembers): boolean {
  if (!rule.refs.length) return true
  return rule.match === 'all' ? rule.refs.every((ref) => rowMatches(row, ref, playlists)) : rule.refs.some((ref) => rowMatches(row, ref, playlists))
}

export function sessionIssues(pool: MediaRow[], setup: SessionSetup, playlists: PlaylistMembers): SessionIssue[] {
  if (!pool.length) return [{ kind: 'empty', from: 0, to: 1 }]
  const required = setup.timeRules.filter((r) => r.mode === 'require')
  const bounds = [...new Set([0, 1, ...required.flatMap((r) => [r.from, r.to])])].sort((a, b) => a - b)
  const issues: SessionIssue[] = []
  for (let i = 1; i < bounds.length; i++) {
    const from = bounds[i - 1]!,
      to = bounds[i]!
    const active = required.filter((r) => r.from < to && r.to > from)
    if (active.length && !pool.some((row) => active.every((rule) => matchesTimeRule(row, rule, playlists)))) issues.push({ kind: 'required', ruleId: active[0]!.id, from, to })
  }
  if (setup.toys.enabled) {
    for (const [i, rule] of setup.toys.periods.entries()) {
      for (const other of setup.toys.periods.slice(i + 1)) {
        if (rule.outputId === other.outputId && rule.scale !== other.scale && rule.scale !== 0 && other.scale !== 0 && rule.from < other.to && other.from < rule.to)
          issues.push({ kind: 'toy-overlap', from: Math.max(rule.from, other.from), to: Math.min(rule.to, other.to) })
      }
    }
  }
  return issues
}

export function videoIntensities(pool: MediaRow[]): Map<number, number> {
  const measured = pool.filter((r) => Number.isFinite(r.averageSpeed) && (r.averageSpeed > 0 || (r.axes.includes('L0') && r.heat.length > 0)))
  const speeds = [...new Set(measured.map((r) => r.averageSpeed))].sort((a, b) => a - b)
  if (speeds.length < 2) return new Map()
  const rank = new Map(speeds.map((speed, i) => [speed, i / (speeds.length - 1)]))
  return new Map(measured.map((row) => [row.id, rank.get(row.averageSpeed)!]))
}

export function intensityWeight(intensity: number | undefined, target: number | null): number {
  return intensity === undefined || target === null ? 1 : 0.1 + 0.9 * Math.exp(-8 * (intensity - target) ** 2)
}

export function toyScale(toys: SessionToySettings, outputId: string, progress: number, intensity: number | null): number {
  if (!toys.enabled) return 1
  const periods = toys.periods.filter((r) => r.outputId === outputId && progress >= r.from && progress < r.to)
  if (periods.length) return Math.min(...periods.map((r) => r.scale))
  const rule = toys.rules.find((r) => r.outputId === outputId)
  if (!rule) return 1
  return intensity === null ? rule.middle : intensity <= toys.low ? rule.low : intensity >= toys.high ? rule.high : rule.middle
}

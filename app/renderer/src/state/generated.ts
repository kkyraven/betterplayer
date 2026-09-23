import type { GenerateState, GeneratedScript } from 'bp-engine'
import { isAxisId } from '@shared/axes'
import type { GeneratedScriptRow, ScriptFile } from '@shared/ipc'
import { TRACK_AXES, defaultTrackingDefaults, type ModelKind, type TrackSource, type TrackingDefaults, type TrackingSettings } from '@shared/tracking'
import { engine, version } from '@/engine/client'
import { invoke } from '@/ipc'
import { t } from '@/state/i18n'
import { ensureFullAudio } from './audio'
import { isUrl, usePlayer } from './player'
import { useSettings } from './settings'
import { trackingSettings, useTracking } from './tracking'

export interface RunSetup {
  key: string
  hash: string
  sources: Set<TrackSource>
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fnv(text: string): string {
  const pass = (seed: number) => {
    let h = seed
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return pass(0x811c9dc5) + pass(0x050c5d1f)
}

export function settingsHash(tracking: TrackingSettings, defaults: TrackingDefaults, present: Record<ModelKind, boolean>, engineVersion: string): string {
  const { flourishes, cutSensitivity, easeMs, clampJumps, models, detectEveryMs, regionPadding, beatStyle, beatVolumeDepth, beatBounce, beatBounceDepth, beatBounceSpeed } = defaults
  return fnv(stable({ beatGenerator: 6, tracking, defaults: { flourishes, cutSensitivity, easeMs, clampJumps, models, detectEveryMs, regionPadding, beatStyle, beatVolumeDepth, beatBounce, beatBounceDepth, beatBounceSpeed }, present, engineVersion }))
}

export function currentSetup(): RunSetup | null {
  const p = usePlayer.getState()
  const t = useTracking.getState()
  if (!p.path || isUrl(p.path) || t.source !== 'player' || t.key !== p.path) return null
  const defaults = useSettings.getState().settings?.tracking ?? defaultTrackingDefaults()
  return { key: p.path, hash: settingsHash(trackingSettings(t), defaults, t.present, version()), sources: new Set(Object.values(t.axes).map((a) => a.source)) }
}

export async function savedResult(setup: RunSetup): Promise<GeneratedScriptRow[] | null> {
  const saved = await invoke('generated:get', setup.key)
  return saved && saved.hash === setup.hash ? saved.scripts : null
}

export async function waitForAudio(key: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  await ensureFullAudio(key)
  for (;;) {
    signal?.throwIfAborted()
    const b = engine.beatState()
    if (usePlayer.getState().path !== key) throw new Error(t('editor.generate.noAudio'))
    if (b.fullStatus === 'ready') return `${Math.round(b.bpm)} BPM`
    if (b.fullStatus === 'error') throw new Error(b.fullError ?? t('editor.generate.noBeatsFound'))
    if (b.fullStatus === 'none') throw new Error(t('editor.generate.noAudio'))
    await new Promise((r) => setTimeout(r, 250))
  }
}

const PROGRESS_MS = 250

export async function runGeneration(onProgress: (p: GenerateState) => void): Promise<GeneratedScript[]> {
  const poll = setInterval(() => onProgress(engine.generateState()), PROGRESS_MS)
  try {
    return await engine.generate()
  } finally {
    clearInterval(poll)
  }
}

export function toRows(scripts: GeneratedScript[]): GeneratedScriptRow[] {
  return scripts.flatMap((s) => (isAxisId(s.axis) ? [{ axis: s.axis, json: s.json }] : []))
}

export function toFiles(rows: GeneratedScriptRow[]): ScriptFile[] {
  return rows.map((r) => ({ suffix: TRACK_AXES.find((a) => a.id === r.axis)?.suffix ?? r.axis.toLowerCase(), json: r.json }))
}

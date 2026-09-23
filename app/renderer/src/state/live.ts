import { useEffect, type DependencyList } from 'react'
import type { EngineState } from 'bp-engine'
import { axes } from '@/engine/client'

export const FLAG_SCRIPT = 1
export const FLAG_DERIVED = 2
export const FLAG_LIVE = 4
export const FLAG_TRACKED = 8

export const AXIS_IDS: readonly string[] = axes().map((a) => a.id)
const INDEX = new Map(AXIS_IDS.map((id, i) => [id, i]))

export interface Live {
  timeMs: number
  durationMs: number
  axisValues: Float64Array
  outputs: EngineState['outputs']
  axisFlags: Uint8Array
  flagsVersion: number
}

type Listener = (live: Live) => void

let current: Live = { outputs: [], timeMs: 0, durationMs: 0, axisValues: new Float64Array(AXIS_IDS.length), axisFlags: new Uint8Array(AXIS_IDS.length), flagsVersion: -1 }
const listeners = new Set<Listener>()

export function get(): Live {
  return current
}

export function set(s: EngineState) {
  const prev = current
  const moved = s.timeMs !== prev.timeMs || s.durationMs !== prev.durationMs || s.flagsVersion !== prev.flagsVersion || !sameValues(s.axisValues, prev.axisValues) || !sameSentOutputs(s.outputs, prev.outputs)
  if (!moved) return
  current = { outputs: s.outputs, timeMs: s.timeMs, durationMs: s.durationMs, axisValues: s.axisValues, axisFlags: s.axisFlags, flagsVersion: s.flagsVersion }
  for (const l of listeners) l(current)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function sameSentOutputs(a: EngineState['outputs'], b: EngineState['outputs']): boolean {
  return a.length === b.length && a.every((output, i) => {
    const other = b[i]
    if (!other || output.id !== other.id || output.status !== other.status) return false
    const sent = output.sentValues ?? {}
    const previous = other.sentValues ?? {}
    return Object.keys(sent).length === Object.keys(previous).length && Object.entries(sent).every(([axis, value]) => value === previous[axis])
  })
}

function sameValues(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function axisIndex(id: string): number {
  return INDEX.get(id) ?? -1
}

export function axisValue(id: string): number {
  return current.axisValues[axisIndex(id)] ?? 0
}

export function axisIdsWith(mask: number): string[] {
  return AXIS_IDS.filter((_, i) => ((current.axisFlags[i] ?? 0) & mask) !== 0)
}

export function useLive(listener: Listener, deps: DependencyList) {
  useEffect(() => {
    listener(current)
    return subscribe(listener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

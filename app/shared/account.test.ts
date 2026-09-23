import { describe, expect, it } from 'vitest'
import { mergeSynced, parsePeerMsg, reconcile, syncPayload } from './account'
import type { PerVideoSettings } from './settings'
import { defaultTrackAxes } from './tracking'

const video: PerVideoSettings = {
  globalOffsetMs: 40,
  axes: { L0: { enabled: true, offsetMs: 0, min: 0.1, max: 0.9, amplitude: 1, invert: false, interpolation: 'linear', provider: 'none', providerSpeed: 1, providerPeriodMs: 1000, providerBlend: 0, fillGapsOverMs: 5000, autoHomeDelayMs: 5000, autoHomeDurationMs: 3000, speedLimit: 0, extendRange: false } },
  variants: { L0: 'hard' },
  position: 12_000,
  tracking: { axes: defaultTrackAxes(), sensitivity: 1, region: null },
}

describe('sync payload', () => {
  it('carries only the synced keys, never variants or tracking', () => {
    const p = syncPayload(video)
    expect(Object.keys(p).sort()).toEqual(['axes', 'globalOffsetMs', 'position'])
    expect(JSON.stringify(p)).not.toContain('hard')
  })

  it('lays a synced entry over the local one and keeps local-only keys', () => {
    const merged = mergeSynced(video, { globalOffsetMs: -20, axes: {}, projection: { kind: 'dome', layout: 'sbs' } as never })
    expect(merged.globalOffsetMs).toBe(-20)
    expect(merged.axes).toEqual({})
    expect(merged.position).toBeUndefined()
    expect(merged.projection).toBeDefined()
    expect(merged.variants).toEqual({ L0: 'hard' })
    expect(merged.tracking).toBeDefined()
    expect(mergeSynced(null, { globalOffsetMs: 5, axes: {} })).toEqual({ globalOffsetMs: 5, axes: {} })
  })
})

describe('peer messages', () => {
  it('accepts well-formed messages and nothing else', () => {
    expect(parsePeerMsg({ t: 'cmd', cmd: 'seek', ms: 5000 })).toEqual({ t: 'cmd', cmd: 'seek', ms: 5000 })
    expect(parsePeerMsg({ t: 'cmd', cmd: 'live', axis: 'L0', value: 0.5 })).toEqual({ t: 'cmd', cmd: 'live', axis: 'L0', value: 0.5 })
    expect(parsePeerMsg({ t: 'cmd', cmd: 'rate', rate: 9 })).toBeNull()
    expect(parsePeerMsg({ t: 'cmd', cmd: 'open', path: '/x.mp4' })).toBeNull()
    expect(parsePeerMsg({ t: 'open', hash: '/Users/x.mp4', positionMs: 0, paused: true })).toBeNull()
    expect(parsePeerMsg({ t: 'open', hash: 'a'.repeat(64), positionMs: 0, paused: true })).toEqual({ t: 'open', hash: 'a'.repeat(64), positionMs: 0, paused: true })
    expect(parsePeerMsg({ t: 'state', media: true, paused: false, positionMs: 1, durationMs: 2, rate: 1, intensity: null, stroke: 0.5, title: 'x' })).not.toHaveProperty('title')
    expect(parsePeerMsg('x')).toBeNull()
  })
})

describe('watch together reconcile', () => {
  const h = 'b'.repeat(64)
  it('opens the host video', () => {
    expect(reconcile({ hash: null, positionMs: 0, paused: true }, { t: 'tick', hash: h, positionMs: 10_000, paused: false })).toEqual({ do: 'open', hash: h, positionMs: 10_000, paused: false })
  })
  it('matches play and pause, then only seeks past the drift window', () => {
    expect(reconcile({ hash: h, positionMs: 10_000, paused: true }, { t: 'tick', hash: h, positionMs: 10_000, paused: false })).toEqual({ do: 'play', positionMs: 10_000 })
    expect(reconcile({ hash: h, positionMs: 10_800, paused: false }, { t: 'tick', hash: h, positionMs: 10_000, paused: false })).toBeNull()
    expect(reconcile({ hash: h, positionMs: 14_000, paused: false }, { t: 'tick', hash: h, positionMs: 10_000, paused: false })).toEqual({ do: 'seek', positionMs: 10_000 })
  })
  it('pauses once when the host has nothing open, and does nothing after', () => {
    expect(reconcile({ hash: h, positionMs: 5000, paused: false }, { t: 'tick', hash: null, positionMs: 0, paused: true })).toEqual({ do: 'pause', positionMs: 5000 })
    expect(reconcile({ hash: h, positionMs: 5000, paused: true }, { t: 'tick', hash: null, positionMs: 0, paused: true })).toBeNull()
    expect(reconcile({ hash: null, positionMs: 0, paused: true }, { t: 'tick', hash: null, positionMs: 0, paused: true })).toBeNull()
  })
})

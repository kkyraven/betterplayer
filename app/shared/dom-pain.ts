// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

export const PAIN_SHAPES = ['saw', 'sine', 'square'] as const
export type PainShape = typeof PAIN_SHAPES[number]
export const PAIN_PHASES = ['riseMs', 'holdMs', 'fallMs', 'gapMs'] as const
export type PainPhase = typeof PAIN_PHASES[number]
export interface PainChannel {
  shape: PainShape
  intensity: number
  riseMs: number
  holdMs: number
  fallMs: number
  gapMs: number
}
export interface PainProfile {
  id: string
  name: string
  volumeMin: number
  volumeMax: number
  channels: [PainChannel, PainChannel, PainChannel, PainChannel]
}
export interface AdvancedPain { enabled: boolean; profiles: PainProfile[] }
export const painCycle = (channel: PainChannel) => PAIN_PHASES.reduce((sum, phase) => sum + channel[phase], 0)
export const painHz = (channel: PainChannel) => 1000 / painCycle(channel)
export function painShape(shape: PainShape, cycleMs = 400): PainChannel {
  return { shape, intensity: 1, riseMs: shape === 'saw' ? cycleMs : shape === 'sine' ? cycleMs / 2 : 0, holdMs: shape === 'square' ? cycleMs / 2 : 0, fallMs: shape === 'sine' ? cycleMs / 2 : 0, gapMs: shape === 'square' ? cycleMs / 2 : 0 }
}
export function painFrequency(channel: PainChannel, hz: number): PainChannel {
  if (!Number.isFinite(hz) || hz < 1 / 60 || hz > 50) return channel
  const cycleMs = 1000 / hz
  const ratio = cycleMs / painCycle(channel)
  const next = { ...channel, riseMs: channel.riseMs * ratio, holdMs: channel.holdMs * ratio, fallMs: channel.fallMs * ratio, gapMs: channel.gapMs * ratio }
  const last = [...PAIN_PHASES].reverse().find((phase) => next[phase] > 0)!
  next[last] += cycleMs - painCycle(next)
  return next
}
export function painWave(channel: PainChannel, elapsedMs: number): number {
  let at = ((elapsedMs % painCycle(channel)) + painCycle(channel)) % painCycle(channel)
  const curve = (t: number) => channel.shape === 'sine' ? (1 - Math.cos(Math.PI * t)) / 2 : channel.shape === 'square' ? 1 : t
  if (channel.riseMs > 0 && at < channel.riseMs) return curve(at / channel.riseMs) * channel.intensity
  at -= channel.riseMs
  if (at < channel.holdMs) return channel.intensity
  at -= channel.holdMs
  return channel.fallMs > 0 && at < channel.fallMs ? (1 - curve(at / channel.fallMs)) * channel.intensity : 0
}
export const defaultPainProfile = (): PainProfile => ({ id: 'whip', name: 'Whip', volumeMin: 0, volumeMax: 1, channels: [painShape('square'), painShape('square'), painShape('square'), painShape('square')] })
export const defaultAdvancedPain = (): AdvancedPain => ({ enabled: false, profiles: [defaultPainProfile()] })
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const unit = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
function normalizeChannel(raw: unknown): PainChannel {
  if (!record(raw)) return painShape('square')
  const shape = PAIN_SHAPES.find((s) => s === raw.shape) ?? 'square'
  const fallback = painShape(shape)
  const channel = { shape, intensity: unit(raw.intensity, 1), riseMs: fallback.riseMs, holdMs: fallback.holdMs, fallMs: fallback.fallMs, gapMs: fallback.gapMs }
  for (const phase of PAIN_PHASES) {
    const value = raw[phase]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) channel[phase] = value
  }
  const total = painCycle(channel)
  if (total < 20 || total > 60000) return { ...fallback, intensity: channel.intensity }
  return channel
}
export function normalizeAdvancedPain(raw: unknown): AdvancedPain {
  if (!record(raw)) return defaultAdvancedPain()
  const ids = new Set<string>()
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).flatMap((p): PainProfile[] => {
    if (!record(p) || typeof p.id !== 'string' || !p.id.trim() || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim()) return []
    ids.add(p.id)
    const channels = Array.isArray(p.channels) ? p.channels : []
    const lo = unit(p.volumeMin, 0), hi = unit(p.volumeMax, 1)
    return [{ id: p.id, name: p.name.trim().slice(0, 100), volumeMin: Math.min(lo, hi), volumeMax: Math.max(lo, hi), channels: [normalizeChannel(channels[0]), normalizeChannel(channels[1]), normalizeChannel(channels[2]), normalizeChannel(channels[3])] }]
  })
  return { enabled: raw.enabled === true, profiles: profiles.length ? profiles : [defaultPainProfile()] }
}

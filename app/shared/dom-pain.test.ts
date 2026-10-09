import { expect, it } from 'vitest'
import { defaultAdvancedPain, normalizeAdvancedPain, painCycle, painFrequency, painHz, painShape, painWave } from './dom-pain'
it('defaults off with a 200 ms on / 200 ms off whip', () => {
  const d = defaultAdvancedPain()
  expect(d.enabled).toBe(false)
  expect(d.profiles[0]!.channels.map(painHz)).toEqual([2.5, 2.5, 2.5, 2.5])
  expect(painWave(d.profiles[0]!.channels[0], 199)).toBe(1)
  expect(painWave(d.profiles[0]!.channels[0], 200)).toBe(0)
  expect(normalizeAdvancedPain({ enabled: 'true' }).enabled).toBe(false)
})
it('changing frequency scales every phase while preserving its proportion', () => {
  const channel = { ...painShape('sine'), riseMs: 100, holdMs: 50, fallMs: 150, gapMs: 100 }
  const changed = painFrequency(channel, 5)
  expect([changed.riseMs, changed.holdMs, changed.fallMs, changed.gapMs]).toEqual([50, 25, 75, 50])
  expect(painHz(changed)).toBe(5)
  expect(painFrequency(channel, 0)).toBe(channel)
})
it('phase changes update total speed, and channel shapes stay independent', () => {
  const channel = { ...painShape('saw'), riseMs: 100, gapMs: 100, intensity: 0.6 }
  expect(painCycle(channel)).toBe(200)
  expect(painHz(channel)).toBe(5)
  expect(painWave(channel, 50)).toBeCloseTo(0.3)
  expect(painWave(channel, 150)).toBe(0)
  expect(painWave(painShape('sine'), 100)).toBeCloseTo(0.5)
})
it('normalizes malformed profiles, duplicate IDs, volume ordering and cycle bounds', () => {
  const d = defaultAdvancedPain().profiles[0]!
  const raw = { ...d, volumeMin: 0.9, volumeMax: 0.2, channels: [{ ...d.channels[0], holdMs: Infinity }, { ...d.channels[1], gapMs: 100000 }, { ...d.channels[2], intensity: -1 }, null] }
  const normalized = normalizeAdvancedPain({ enabled: true, profiles: [raw, raw, {}] })
  expect(normalized.profiles).toHaveLength(1)
  expect(normalized.profiles[0]?.volumeMin).toBe(0.2)
  expect(normalized.profiles[0]?.channels.map(painCycle)).toEqual([400, 400, 400, 400])
  expect(normalized.profiles[0]?.channels[2].intensity).toBe(0)
})

it.each([50, 1 / 60])('keeps %s Hz inside the native cycle range', (hz) => {
  const channel = { ...painShape('sine'), riseMs: 7, holdMs: 31, fallMs: 53, gapMs: 97 }
  const changed = painFrequency(channel, hz)
  expect(painCycle(changed)).toBeGreaterThanOrEqual(20)
  expect(painCycle(changed)).toBeLessThanOrEqual(60000)
  const profile = defaultAdvancedPain().profiles[0]!
  profile.channels[0] = changed
  expect(normalizeAdvancedPain({ enabled: true, profiles: [profile] }).profiles[0]?.channels[0]).toEqual(changed)
})

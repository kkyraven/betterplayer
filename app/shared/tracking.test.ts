import { describe, expect, it } from 'vitest'
import { createTranslator, ENGLISH } from './i18n'
import { describeEffect, describeTrigger, heroFileText, looksLikeMusicVideo, normalizeZoneEffects, parseHeroFile } from './tracking'

const t = createTranslator('en', ENGLISH)

describe('looksLikeMusicVideo', () => {
  it('matches the music video markers', () => {
    for (const title of ['Cock Hero 12', 'Summer CH', 'Neon HMV', 'best pmv ever', 'Anime AMV', 'IFL Blue', 'I fucking love this', 'I Fcking Love It', 'Music mix 3']) {
      expect(looksLikeMusicVideo(title), title).toBe(true)
    }
  })

  it('leaves other titles alone', () => {
    for (const title of ['Beach day', 'chapter one', 'Musical chairs', 'PMVS', 'Hi flower']) {
      expect(looksLikeMusicVideo(title), title).toBe(false)
    }
  })
})

describe('hero file', () => {
  const setup = {
    heroZone: { x: 0.1, y: 0.4, w: 0.1, h: 0.2 },
    heroDirection: 'right-to-left' as const,
    heroColours: { 3: { intensity: 0.8, flourish: 'hold' as const, smooth: 0.5, ignore: false } },
    heroAxisColours: { R0: { 3: { intensity: 0.2, flourish: 'none' as const, smooth: 0, ignore: true } } },
  }

  it('round trips a setup', () => {
    const text = heroFileText(setup)
    expect(JSON.parse(text)).toMatchObject({ format: 'betterplayer.cockhero', version: 1 })
    expect(parseHeroFile(text)).toEqual({ format: 'betterplayer.cockhero', version: 1, zone: setup.heroZone, direction: 'right-to-left', colours: setup.heroColours, axisColours: setup.heroAxisColours })
  })

  it('fills in a bare setup', () => {
    expect(parseHeroFile(heroFileText({}))).toEqual({ format: 'betterplayer.cockhero', version: 1, zone: null, direction: 'auto', colours: {}, axisColours: {} })
  })

  it('rejects other files and out of range fields', () => {
    const good = JSON.parse(heroFileText(setup)) as Record<string, unknown>
    const bad = (patch: Record<string, unknown>) => parseHeroFile(JSON.stringify({ ...good, ...patch }))
    expect(parseHeroFile('not json')).toBeNull()
    expect(parseHeroFile('{"actions":[]}')).toBeNull()
    expect(bad({ version: 2 })).toBeNull()
    expect(bad({ direction: 'sideways' })).toBeNull()
    expect(bad({ zone: { x: 1.5, y: 0, w: 0.1, h: 0.1 } })).toBeNull()
    expect(bad({ zone: { x: 0, y: 0, w: 0, h: 0.1 } })).toBeNull()
    expect(bad({ colours: { 3: { intensity: 9, flourish: 'hold', smooth: 0, ignore: false } } })).toBeNull()
    expect(bad({ colours: { 3: { intensity: 1, flourish: 'twirl', smooth: 0, ignore: false } } })).toBeNull()
    expect(bad({ colours: { x: { intensity: 1, flourish: 'hold', smooth: 0, ignore: false } } })).toBeNull()
    expect(bad({ axisColours: { R0: 'no' } })).toBeNull()
  })
})


describe('zone effects', () => {
  const zone = { id: 'z1', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, trigger: { kind: 'colour' as const, buckets: [0, 11] }, cover: 0.2, holdMs: 500, effect: { tempo: 2, intensity: 1, playbackSpeed: 1, estimMax: 0.9 } }
  const part = { ...zone, id: 'z2', trigger: { kind: 'part' as const, target: 'faces' as const }, effect: { tempo: 1, intensity: 1.2, playbackSpeed: 1, estimMax: null, vibeMax: 1 } }

  it('round-trips zones in the file and leaves them out when there are none', () => {
    const zones = { enabled: true, zones: [zone, part] }
    expect(parseHeroFile(heroFileText({ zones }))).toMatchObject({ zones })
    expect(JSON.parse(heroFileText({ zones: { enabled: false, zones: [] } }))).not.toHaveProperty('zones')
  })

  it('rejects a zone with a bad box, colour, part, or field', () => {
    const file = (patch: Record<string, unknown>) => parseHeroFile(JSON.stringify({ ...JSON.parse(heroFileText({})), zones: { enabled: true, zones: [{ ...zone, ...patch }] } }))
    expect(file({})).not.toBeNull()
    for (const patch of [{ region: { x: 0, y: 0, w: 0, h: 0.1 } }, { trigger: { kind: 'colour', buckets: [13] } }, { trigger: { kind: 'part', target: 'hands' } }, { cover: 2 }, { holdMs: -1 }, { effect: { ...zone.effect, tempo: 9 } }, { id: '' }]) {
      expect(file(patch), JSON.stringify(patch)).toBeNull()
    }
    expect(parseHeroFile(JSON.stringify({ ...JSON.parse(heroFileText({})), zones: { enabled: true, zones: [zone, zone] } }))).toBeNull()
  })

  it('pulls saved zones into range and drops the unusable', () => {
    const saved = normalizeZoneEffects({ enabled: true, zones: [{ ...zone, cover: 3, holdMs: 1e9, trigger: { kind: 'colour', buckets: [11, 11, 99] }, effect: { tempo: 100, estimMax: 2 } }, { ...part, region: null }, 'no'] })
    expect(saved).toEqual({ enabled: true, zones: [{ ...zone, cover: 1, holdMs: 60000, trigger: { kind: 'colour', buckets: [11] }, effect: { tempo: 4, intensity: 1, playbackSpeed: 1, estimMax: 1 } }] })
  })

  it('describes a zone in words', () => {
    expect(describeTrigger(zone, t)).toBe('Red, Pink · 20% of zone')
    expect(describeTrigger(part, t)).toBe('Face in zone')
    expect(describeEffect(zone.effect, t)).toBe('Tempo 2× · Estim max 90%')
    expect(describeEffect(part.effect, t)).toBe('Intensity 120% · Vibrate max 100%')
    expect(describeEffect({ tempo: 1, intensity: 1, playbackSpeed: 1, estimMax: null }, t)).toBe('No change')
  })
})

describe('Hero music file', () => {
  const heroMusic = { enabled: true, rules: { 11: { durationMs: 4000, tempo: 2, intensity: 1.25, playbackSpeed: 0.75, strokeSpeed: 1.5, estimMax: 0.9 } } }
  it('round-trips advanced modifiers alongside the zone', () => {
    const zone = { x: 0.1, y: 0.4, w: 0.08, h: 0.2 }
    expect(parseHeroFile(heroFileText({ heroMusic, heroZone: zone }))).toMatchObject({ music: heroMusic, zone })
  })
  it('rejects malformed or out-of-range overrides without silently enabling them', () => {
    const file = JSON.parse(heroFileText({ heroMusic }))
    for (const patch of [{ durationMs: 0 }, { tempo: 5 }, { intensity: -1 }, { playbackSpeed: 0 }, { estimMax: 2 }, { strokeSpeed: -1 }, { strokeSpeed: 21 }]) {
      expect(parseHeroFile(JSON.stringify({ ...file, music: { ...heroMusic, rules: { 11: { ...heroMusic.rules[11], ...patch } } } }))).toBeNull()
    }
    expect(parseHeroFile(JSON.stringify({ ...file, music: { enabled: true, rules: { 99: heroMusic.rules[11] } } }))).toBeNull()
    expect(parseHeroFile(JSON.stringify({ ...file, music: null }))).toBeNull()
  })
})

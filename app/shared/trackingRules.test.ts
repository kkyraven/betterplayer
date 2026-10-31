import { describe, expect, it } from 'vitest'
import { defaultTrackAxes, defaultTrackingDefaults, newZone, TRACK_AXIS_IDS, type OwnAxes, type TrackAxesConfig, type TrackAxisId, type TrackingDefaults, type TrackingSettings, type TrackSource } from './tracking'
import { allVideosChange, changeRules, convertLegacy, hasOverrides, hostedNeedsRun, musicFolders, musicMatters, musicSignal, musicSource, musicWords, resolve, withoutOverrides, type LegacyInput, type VideoResolveInput } from './trackingRules'

const fresh = defaultTrackingDefaults()
const rules = (patch: Partial<TrackingDefaults>): TrackingDefaults => ({ ...fresh, ...patch })
const axisSet = (...ids: TrackAxisId[]) => new Set<TrackAxisId>(ids)
const pmv = { kind: 'title', text: 'PMV' } as const
const sources = (axes: Record<TrackAxisId, { source: TrackSource }>) => TRACK_AXIS_IDS.map((id) => axes[id].source).join(' ')
const MOTION = 'ai-motion ai-motion ai-motion ai-motion ai-motion off'
const OFF = 'off off off off off off'
const table = (source: TrackSource, patch: Partial<Record<TrackAxisId, TrackSource>> = {}): TrackAxesConfig => {
  const axes = defaultTrackAxes()
  for (const id of TRACK_AXIS_IDS) axes[id] = { ...axes[id], source: patch[id] ?? (id === 'R0' ? 'off' : source) }
  return axes
}

const player = (patch: Partial<VideoResolveInput> = {}): VideoResolveInput => ({ side: 'player', rules: fresh, video: undefined, scripted: axisSet(), music: null, manual: false, hold: false, ...patch })
const page = (patch: Partial<VideoResolveInput> = {}): VideoResolveInput => player({ side: 'browser', manual: true, ...patch })

describe('musicSource', () => {
  it('follows Auto, Same and the explicit choices', () => {
    const cases: [TrackingDefaults['fill'], TrackingDefaults['musicFill'], string][] = [
      ['ai-motion', 'auto', 'ai-music'],
      ['beat', 'auto', 'beat'],
      ['off', 'auto', 'off'],
      ['ai-motion', 'same', 'ai-motion'],
      ['off', 'beat', 'beat'],
      ['beat', 'ai-music', 'ai-music'],
    ]
    for (const [fill, musicFill, expected] of cases) expect(musicSource({ fill, musicFill }), `${fill} ${musicFill}`).toBe(expected)
  })
})

describe('music words', () => {
  it('matches PMV, HMV, AMV, an uppercase CH and cock or fap hero', () => {
    const cases = [['CH - Round 3', 'CH'], ['[CH] Name', 'CH'], ['PMV_Mix', 'PMV'], ['my_pmv_v2', 'pmv'], ['Cock Hero 4', 'Cock Hero'], ['FapHero', 'FapHero'], ['PMVs', 'PMVs'], ['Neon hmv', 'hmv'], ['【ＰＭＶ】 Mix', 'PMV']]
    for (const [name, words] of cases) expect(musicWords(name ?? ''), name).toBe(words)
  })

  it('leaves CH inside words, bare hero, music and IFL alone', () => {
    const decomposed = ['MLADÝCH', 'NOHÁCH'].map((name) => name.normalize('NFD'))
    for (const name of ['BEACH', 'TEACHER', 'CHLOE', 'FRENCH', 'MACHINE', 'CZECH', 'WATCH ME', 'CHN-123', 'chapter one', 'Superhero', 'Heroine', 'Music Room', 'IFL Blue', 'I fucking love this', 'Ch 3', ...decomposed]) {
      expect(musicWords(name), name).toBeNull()
    }
  })
})

describe('musicSignal', () => {
  const none = { heroFile: false, tags: [], folders: [], title: 'Clip' }

  it('takes the first hit: the mark, the Hero file, a tag, a folder, then the title', () => {
    const all = { heroFile: true, tags: ['PMV'], folders: ['PMVs'], title: 'HMV mix' }
    expect(musicSignal({ ...all, notMusic: true })).toBeNull()
    expect(musicSignal(all)).toEqual({ kind: 'hero-file' })
    expect(musicSignal({ ...all, heroFile: false })).toEqual({ kind: 'tag', text: 'PMV' })
    expect(musicSignal({ ...all, heroFile: false, tags: ['solo'] })).toEqual({ kind: 'folder', text: 'PMVs' })
    expect(musicSignal({ ...all, heroFile: false, tags: [], folders: ['Clips'] })).toEqual({ kind: 'title', text: 'HMV' })
    expect(musicSignal(none)).toBeNull()
  })

  it('matches whole tags from the list in any case', () => {
    for (const tag of ['pmv', 'Cock Hero', 'faphero', 'CH', 'Music Video']) expect(musicSignal({ ...none, tags: [tag] }), tag).toEqual({ kind: 'tag', text: tag })
    for (const tag of ['pmvs', 'music', 'hero', 'chapter']) expect(musicSignal({ ...none, tags: [tag] }), tag).toBeNull()
  })
})

describe('musicFolders', () => {
  it('reads a library folder below its root, else the two nearest parents', () => {
    expect(musicFolders('/lib/Music/PMVs/a.mp4', 'Music/PMVs')).toEqual(['Music', 'PMVs'])
    expect(musicFolders('/PMV/a.mp4', '')).toEqual([])
    expect(musicFolders('C:\\Videos\\PMVs\\Mix\\a.mp4', null)).toEqual(['PMVs', 'Mix'])
    expect(musicFolders('/a.mp4', undefined)).toEqual([])
    expect(musicFolders('https://stash.fictional/PMVs/stream', null)).toEqual([])
  })
})

describe('resolve', () => {
  it('gives a fresh install AI Motion on unscripted videos and nothing beside a script', () => {
    const unscripted = resolve(player())
    expect(sources(unscripted.axes)).toBe(MOTION)
    expect(unscripted).toMatchObject({ start: true, byRule: true, musicChanged: false, picked: [] })
    const scripted = resolve(player({ scripted: axisSet('L0') }))
    expect(sources(scripted.axes)).toBe(OFF)
    expect(scripted).toMatchObject({ start: false, byRule: false })
    expect(scripted.auto.L0).toBe('off')
  })

  it('walks the personas', () => {
    const cases: [string, VideoResolveInput, string][] = [
      ['scripts only, unscripted', player({ rules: rules({ fill: 'off' }) }), OFF],
      ['scripts only, music on Auto', player({ rules: rules({ fill: 'off' }), music: pmv }), OFF],
      ['AI fills, music video', player({ music: pmv }), 'ai-music ai-music ai-music ai-music ai-music off'],
      ['music on Beat through Auto', player({ rules: rules({ fill: 'beat' }), music: pmv }), 'beat beat beat beat beat off'],
      ['music on Beat, others AI Motion', player({ rules: rules({ musicFill: 'beat' }), music: pmv }), 'beat beat beat beat beat off'],
      ['SR6, stroke-only script', player({ scripted: axisSet('L0') }), OFF],
      ['fill empty axes on', player({ rules: rules({ fillScripted: true }), scripted: axisSet('L0') }), 'off ai-motion ai-motion ai-motion ai-motion off'],
      ['page Track', page({ rules: rules({ fill: 'off' }) }), MOTION],
      ['faptap page', page({ faptapPage: true }), 'faptap ai-motion ai-motion ai-motion ai-motion off'],
      ['page on Beat plays AI Motion', page({ rules: rules({ fill: 'beat' }) }), MOTION],
    ]
    for (const [name, input, expected] of cases) expect(sources(resolve(input).axes), name).toBe(expected)
  })

  it('shows the Music video chip only when classification changed a source', () => {
    expect(resolve(player({ music: pmv })).musicChanged).toBe(true)
    expect(resolve(player({ rules: rules({ fill: 'beat' }), music: pmv })).musicChanged).toBe(false)
    expect(resolve(player({ rules: rules({ musicFill: 'same' }), music: pmv })).musicChanged).toBe(false)
    expect(resolve(player({ scripted: axisSet(...TRACK_AXIS_IDS), music: pmv })).musicChanged).toBe(false)
    expect(resolve(page({ music: pmv })).musicChanged).toBe(false)
  })

  it('remembers a Stop and starts on a press', () => {
    const stopped = resolve(player({ video: { on: false, own: { L0: { source: 'beat' } } } }))
    expect(stopped).toMatchObject({ start: false, byRule: true, picked: ['L0'] })
    expect(sources(stopped.axes)).toBe(OFF)
    const pressed = resolve(player({ scripted: axisSet('L0'), manual: true }))
    expect(sources(pressed.axes)).toBe('off ai-motion ai-motion ai-motion ai-motion off')
    expect(pressed).toMatchObject({ start: true, byRule: false })
    expect(sources(resolve(player({ scripted: axisSet('L0'), video: { on: true } })).axes)).toBe(sources(pressed.axes))
  })

  it('always does something on a press', () => {
    const scripted = resolve(player({ scripted: axisSet(...TRACK_AXIS_IDS), manual: true }))
    expect(sources(scripted.axes)).toBe('ai-motion off off off off off')
    expect(scripted.auto.L0).toBe('ai-motion')
    expect(sources(resolve(player({ rules: rules({ fill: 'off' }), music: pmv, manual: true })).axes)).toBe('ai-music ai-music ai-music ai-music ai-music off')
    const same = resolve(player({ rules: rules({ fill: 'off', musicFill: 'same' }), music: pmv, manual: true }))
    expect(same).toMatchObject({ musicChanged: false })
    expect(sources(same.axes)).toBe(MOTION)
    expect(musicMatters(rules({ fill: 'off', musicFill: 'same' }), true)).toBe(false)
  })

  it('holds a session before start unless pressed', () => {
    expect(resolve(player({ hold: true }))).toMatchObject({ start: false, byRule: true })
    expect(resolve(player({ hold: true, manual: true })).start).toBe(true)
  })

  it('starts for zones in the player with every axis off, unless held or stopped', () => {
    const zones = { enabled: true, zones: [newZone({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })] }
    const zoned = resolve(player({ scripted: axisSet('L0'), video: { own: {}, zones } }))
    expect(zoned).toMatchObject({ start: true, byRule: false })
    expect(sources(zoned.axes)).toBe(OFF)
    expect(resolve(player({ scripted: axisSet('L0'), video: { own: {}, zones, on: false } })).start).toBe(false)
    expect(resolve(player({ scripted: axisSet('L0'), video: { own: {}, zones }, hold: true })).start).toBe(false)
    expect(resolve(player({ scripted: axisSet('L0'), video: { own: {}, zones: { ...zones, enabled: false } } })).start).toBe(false)
    expect(resolve(page({ manual: false, rules: rules({ fill: 'off' }), video: { own: {}, zones } })).start).toBe(false)
    expect(allVideosChange(player({ video: { own: {}, zones } }), false).on).toBe(false)
  })

  it('puts picks over the script and tuning over the global row', () => {
    const r = resolve(player({ scripted: axisSet('L0'), video: { own: { L0: { source: 'beat' }, L2: { max: 0.5 } } } }))
    expect(sources(r.axes)).toBe('beat off off off off off')
    expect(r).toMatchObject({ start: true, byRule: false, picked: ['L0'] })
    expect(r.auto.L0).toBe('off')
    expect(r.axes.L2).toEqual({ ...fresh.axes.L2, source: 'off', max: 0.5 })
  })

  it('fills only switched-on axes, while a pick works on any', () => {
    expect(resolve(player()).axes.R0.source).toBe('off')
    expect(resolve(player({ video: { own: { R0: { source: 'video' } } } })).axes.R0.source).toBe('video')
  })

  it('keeps each side to the sources it can play', () => {
    expect(resolve(player({ video: { own: { L0: { source: 'faptap' } } } })).axes.L0.source).toBe('ai-motion')
    expect(resolve(page({ video: { own: { L0: { source: 'beat' }, L2: { source: 'faptap' } } } })).axes.L2.source).toBe('ai-motion')
    const game = resolve({ side: 'game', game: table('hero') })
    expect(sources(game.axes)).toBe('video video video video video off')
    expect(game.start).toBe(true)
  })
})

describe('changeRules', () => {
  const allOff = rules({ fill: 'off', axes: table('off') })

  it('turns the shipped axes back on when a fill is chosen with every switch off', () => {
    expect(sources(changeRules(allOff, { fill: 'beat' }).axes)).toBe('video video video video video off')
    expect(sources(changeRules(allOff, { musicFill: 'ai-music' }).axes)).toBe('video video video video video off')
    expect(changeRules(allOff, { fill: 'off' }).axes).toBe(allOff.axes)
    const someOn = rules({ fill: 'off', axes: table('off', { R0: 'video' }) })
    expect(changeRules(someOn, { fill: 'ai-motion' }).axes).toBe(someOn.axes)
  })
})

describe('allVideosChange', () => {
  it('flips the rule that applied and undoes it', () => {
    const stop = allVideosChange(player({ video: { on: false } }), false)
    expect(stop).toEqual({ rules: { fill: 'off' }, on: undefined, undo: { rules: { fill: 'ai-motion' }, on: false } })
    expect(allVideosChange(player({ rules: rules({ musicFill: 'beat' }), music: pmv }), false).rules).toEqual({ fill: 'off', musicFill: 'auto' })
    expect(allVideosChange(player({ rules: rules({ fillScripted: true }), scripted: axisSet('L0') }), false).rules).toEqual({ fillScripted: false })
    expect(allVideosChange(player({ scripted: axisSet('L0') }), true).rules).toEqual({ fillScripted: true })
  })

  it('keeps the crosshair memory while the video\'s own picks would undo the change', () => {
    expect(allVideosChange(player({ video: { own: { L0: { source: 'beat' } }, on: false } }), false).on).toBe(false)
    const offPicks: OwnAxes = Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, { source: 'off' }]))
    expect(allVideosChange(player({ rules: rules({ fill: 'off' }), video: { own: offPicks, on: true } }), true).on).toBe(true)
  })

  it('makes the rule give what the press gave', () => {
    expect(allVideosChange(player({ rules: rules({ fill: 'off' }), scripted: axisSet('L0') }), true)).toMatchObject({ rules: { fillScripted: true, fill: 'ai-motion' }, on: undefined })
    const allOff = rules({ fill: 'off', axes: table('off') })
    const start = allVideosChange(player({ rules: allOff, video: { on: true } }), true)
    expect(sources(start.rules.axes ?? allOff.axes)).toBe('video video video video video off')
    expect(start.undo).toEqual({ rules: { fill: 'off', axes: allOff.axes }, on: true })
    expect(allVideosChange(player({ rules: rules({ axes: table('off', { L0: 'video' }) }), scripted: axisSet('L0') }), true).on).toBe(true)
  })

  it('keeps a fill that gave the press and turns the switches back on', () => {
    const beatOff = rules({ fill: 'beat', axes: table('off') })
    const start = allVideosChange(player({ rules: beatOff, video: { on: true } }), true)
    expect(start.rules.fill).toBe('beat')
    expect(sources(start.rules.axes ?? beatOff.axes)).toBe('video video video video video off')
    expect(start.on).toBeUndefined()
    expect(resolve(player({ rules: { ...beatOff, ...start.rules } })).axes.L0.source).toBe('beat')
    const music = allVideosChange(player({ rules: rules({ fill: 'off', musicFill: 'beat', axes: table('off') }), music: pmv, video: { on: true } }), true)
    expect(music.rules).toEqual({ musicFill: 'beat', axes: start.rules.axes })
  })
})

describe('hostedNeedsRun', () => {
  it('runs for a Handy only when the stroke is generated, for a Howl when any axis is', () => {
    const side = table('off', { L2: 'ai-motion' })
    expect(hostedNeedsRun('handy', side)).toBe(false)
    expect(hostedNeedsRun('howl', side)).toBe(true)
    expect(hostedNeedsRun('handy', table('off', { L0: 'beat' }))).toBe(true)
    expect(hostedNeedsRun('howl', table('off'))).toBe(false)
    expect(hostedNeedsRun('serial', table('video'))).toBe(false)
  })
})

describe('overrides', () => {
  it('counts legacy tables, picks, tuning, the crosshair, the music mark and sensitivity', () => {
    const base: TrackingSettings = { region: null, own: {}, pace: 0.3 }
    expect(hasOverrides(undefined)).toBe(false)
    expect(hasOverrides(base)).toBe(false)
    for (const patch of [{ own: undefined, axes: fresh.axes }, { own: { L0: { max: 0.5 } } }, { on: false }, { notMusic: true as const }, { sensitivity: 1.2 }]) {
      expect(hasOverrides({ ...base, ...patch }), JSON.stringify(patch)).toBe(true)
    }
  })

  it('keeps pace, region and the Hero setup in the current format, or drops what is left empty', () => {
    const legacy: TrackingSettings = { axes: fresh.axes, sensitivity: 1, region: null }
    expect(withoutOverrides(legacy)).toBeUndefined()
    const zone = { x: 0.1, y: 0.4, w: 0.1, h: 0.2 }
    const kept = withoutOverrides({ ...legacy, on: true, notMusic: true, own: { L0: { source: 'beat' } }, pace: 0.3, heroZone: zone })
    expect(kept).toEqual({ region: null, pace: 0.3, heroZone: zone, axes: fresh.axes, own: {} })
    expect(hasOverrides(kept)).toBe(false)
  })
})

describe('convertLegacy', () => {
  const at = (patch: Partial<LegacyInput> = {}): LegacyInput => ({ side: 'player', rules: fresh, scripted: axisSet(), title: 'Clip', ...patch })
  const saved = (axes: TrackAxesConfig, patch: Partial<TrackingSettings> = {}): TrackingSettings => ({ axes, sensitivity: 1, region: null, ...patch })
  const picks = (t: TrackingSettings | undefined) => Object.fromEntries(Object.entries(t?.own ?? {}).flatMap(([id, own]) => (own.source ? [[id, own.source]] : [])))

  it('passes current records and nothing through', () => {
    const current: TrackingSettings = { region: null, own: {} }
    expect(convertLegacy(current, at())).toBe(current)
    expect(convertLegacy(undefined, at())).toBeUndefined()
  })

  it('releases automatic picks, Reset copies and flipped motion switches', () => {
    const cases: [string, TrackingSettings, LegacyInput][] = [
      ['SR6 stroke-only table', saved(table('ai-motion', { L0: 'off' })), at({ scripted: axisSet('L0') })],
      ['Reset copy with Video over the script', saved(table('video')), at({ scripted: axisSet('L0') })],
      ['every row on Beat, CH title on AI CH/PMV', saved(table('ai-music', { R0: 'ai-music' })), at({ rules: rules({ axes: table('beat', { R0: 'beat' }) }), title: 'Summer CH' })],
      ['saved with the motion switch off', saved(table('ai-motion')), at({ rules: rules({ motionDefault: false }) })],
      ['faptap page', saved(table('ai-motion', { L0: 'faptap' })), at({ side: 'browser', faptapPage: true })],
    ]
    for (const [name, record, input] of cases) expect(picks(convertLegacy(record, input)), name).toEqual({})
  })

  it('keeps deliberate choices as picks', () => {
    const cases: [string, TrackingSettings, LegacyInput, Record<string, TrackSource>][] = [
      ['Beat on the stroke', saved(table('ai-motion', { L0: 'beat' })), at(), { L0: 'beat' }],
      ['Hero on a title that is not music', saved(table('ai-motion', { L0: 'hero' })), at(), { L0: 'hero' }],
      ['AI CH/PMV on a title that is not music', saved(table('ai-music')), at(), { L0: 'ai-music', L2: 'ai-music', L1: 'ai-music', R1: 'ai-music', R2: 'ai-music' }],
      ['AI Motion over the script', saved(table('ai-motion')), at({ scripted: axisSet('L0') }), { L0: 'ai-motion' }],
      ['an axis switched off by hand', saved(table('ai-motion', { L2: 'off' })), at(), { L2: 'off' }],
    ]
    for (const [name, record, input, expected] of cases) expect(picks(convertLegacy(record, input)), name).toEqual(expected)
  })

  it('keeps tuning and video fields that differ, and drops the start values', () => {
    const axes = table('ai-motion')
    axes.L2 = { ...axes.L2, max: 0.5 }
    const zones = { enabled: true, zones: [] }
    const record = saved(axes, { sensitivity: 1, pace: fresh.defaultPace, regionSource: 'centre', beatTempoFactor: 1, heroZone: { x: 0.1, y: 0.4, w: 0.1, h: 0.2 }, zones })
    expect(convertLegacy(record, at())).toEqual({ region: null, own: { L2: { max: 0.5 } }, heroZone: record.heroZone, zones })
    expect(convertLegacy({ ...record, sensitivity: 1.4, pace: 0.8, regionSource: 'pick', beatTempoFactor: 2 }, at())).toMatchObject({ sensitivity: 1.4, pace: 0.8, regionSource: 'pick', beatTempoFactor: 2 })
  })

  it('leaves a migrated SR6 video with nothing tracked', () => {
    const converted = convertLegacy(saved(table('ai-motion', { L0: 'off' })), at({ scripted: axisSet('L0') }))
    expect(resolve(player({ video: converted, scripted: axisSet('L0') })).start).toBe(false)
  })
})

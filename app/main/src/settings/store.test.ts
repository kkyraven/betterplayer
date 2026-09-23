import { describe, expect, it } from 'vitest'
import { defaultDlss, defaultEstim, defaultParamSource, defaultSettings } from '@shared/settings'
import { migrate, readPerVideo } from './store'

const buttplug = { kind: 'buttplug', profile: 'stroker', url: 'ws://127.0.0.1:12345' }

it('leaves restim parameters unsent by default, including older saved outputs', () => {
  const settings = migrate({ version: 1, devices: { outputs: [{ kind: 'websocket', url: 'ws://127.0.0.1:12346' }] } })
  expect(settings.estim.params).toBe(false)
  const output = settings.devices.outputs[0]
  expect(output?.profile).toBe('restim')
  for (const axis of ['C0', 'P0', 'P1', 'P2', 'P3'] as const) {
    expect(output?.params?.[axis] ?? defaultParamSource()).toMatchObject({ source: 'restim', value: 0.5 })
  }
})

describe('language', () => {
  it('defaults to the system and drops a locale the app no longer bundles', () => {
    expect(migrate(null).general.language).toBe('auto')
    expect(migrate({ version: 1, general: { language: 'en' } }).general.language).toBe('en')
    expect(migrate({ version: 1, general: { language: 'tlh' } }).general.language).toBe('auto')
  })
})

describe('restim volume floor', () => {
  it('defaults to 75%, persists a chosen floor and clamps invalid values', () => {
    expect(migrate(null).estim.volumeFloor).toBe(0.75)
    expect(migrate({ version: 1, estim: { contrast: 0.5 } }).estim.volumeFloor).toBe(0.75)
    for (const [value, expected] of [[0.4, 0.4], [0, 0], [1.5, 1], [-1, 0], [NaN, 0.75]]) {
      expect(migrate({ version: 1, estim: { volumeFloor: value } }).estim.volumeFloor).toBe(expected)
    }
  })
  it('preserves old floors and defaults boost off when adding the upper limit', () => {
    expect(migrate({ version: 1, estim: { volumeFloor: 0.6 } }).estim).toEqual({ ...defaultEstim(), volumeFloor: 0.6 })
  })
  it('keeps both volume limits and the selected boost settings across restarts', () => {
    const estim = { ...defaultEstim(), volumeFloor: 0.75, volumeMax: 0.85, volumeBoost: { enabled: true, axis: 'L2', amount: 0.3 } }
    expect(migrate({ version: 1, estim }).estim).toEqual(estim)
    const invalid = migrate({ version: 1, estim: { volumeFloor: 0.9, volumeMax: 0.2, volumeBoost: { enabled: true, axis: 'EV', amount: 2 } } }).estim
    expect(invalid.volumeMax).toBe(0.9)
    expect(invalid.volumeBoost).toEqual({ enabled: false, axis: 'L1', amount: 1 })
  })
})

describe('upscaling', () => {
  it('defaults DLSS processing to Auto and preserves fixed budgets and reserved preferences', () => {
    expect(migrate(null).upscaling.dlss.inputHeight).toBe(0)
    for (const inputHeight of [0, 480, 720, 1080, 1440, 2160]) {
      const dlss = { ...defaultDlss(), inputHeight, rate: '24', guide: 'quality', bufferSeconds: 12 }
      expect(migrate({ version: 1, upscaling: { upscaler: 'dlss', dlss } }).upscaling.dlss).toEqual(dlss)
    }
    expect(migrate({ version: 1, upscaling: { dlss: { inputHeight: 999 } } }).upscaling.dlss.inputHeight).toBe(0)
  })
  it('preserves Apple AI across restarts and rejects unknown upscalers', () => {
    expect(migrate({ version: 1, upscaling: { upscaler: 'apple', frameGen: 'off' } }).upscaling).toEqual({ upscaler: 'apple', frameGen: 'off', dlss: defaultDlss() })
    expect(migrate({ version: 1, upscaling: { upscaler: 'unknown' } }).upscaling.upscaler).toBe('off')
  })
})

describe('intiface default', () => {
  it('is off for a fresh install and for a file without the group', () => {
    expect(defaultSettings().intiface.alwaysOn).toBe(false)
    expect(migrate(null).intiface.alwaysOn).toBe(false)
    expect(migrate({ version: 1 }).intiface.alwaysOn).toBe(false)
  })

  it('stays off when a Buttplug output holds the port', () => {
    expect(migrate({ version: 1, devices: { outputs: [buttplug] } }).intiface.alwaysOn).toBe(false)
  })

  it('keeps an explicit choice', () => {
    expect(migrate({ version: 1, intiface: { alwaysOn: false } }).intiface.alwaysOn).toBe(false)
    const settings = migrate({ version: 1, devices: { outputs: [buttplug] }, intiface: { alwaysOn: true } })
    expect(settings.intiface.alwaysOn).toBe(true)
    expect(migrate(settings).intiface.alwaysOn).toBe(true)
  })

  it('resets the legacy automatic-on value once, preserving the port and help preference', () => {
    for (const enabled of [true, false]) {
      expect(migrate({ version: 1, intiface: { enabled, port: 23456, faptapHelpSeen: true } }).intiface)
        .toEqual({ alwaysOn: false, port: 23456, faptapHelpSeen: true })
    }
  })
})

describe('vibration', () => {
  it('keeps a saved vibration within range and drops a malformed one', () => {
    const serial = { kind: 'serial', profile: 'stroker', path: '/dev/tty.usbserial' }
    const outputs = migrate({ version: 1, devices: { outputs: [{ ...serial, vibration: { source: 'V0', depth: 0.9, hz: 8 } }, { ...serial, vibration: 'yes' }] } }).devices.outputs
    expect(outputs[0]?.vibration).toEqual({ source: 'V0', depth: 0.25, hz: 8 })
    expect(outputs[1]?.vibration).toBeUndefined()
  })
})

describe('delay', () => {
  it('keeps a saved delay within range, either sign, and drops zero or junk', () => {
    const serial = { kind: 'serial', profile: 'stroker', path: '/dev/tty.usbserial' }
    const outputs = migrate({ version: 1, devices: { outputs: [{ ...serial, delayMs: 80 }, { ...serial, delayMs: -900 }, { ...serial, delayMs: 0 }, { ...serial, delayMs: '80' }] } }).devices.outputs
    expect(outputs.map((o) => o.delayMs)).toEqual([80, -500, undefined, undefined])
  })
})

describe('toy feature levels', () => {
  const toy = { kind: 'toy', profile: 'stroker', device: 'Nora', address: 'A' }
  it('keeps a level map in order and within range, and drops the identity and junk', () => {
    const levels = { 0: { from: 0.1, to: 0.6, floor: 0.2, cap: 0.8 }, 1: { from: 0.7, to: 0.2, floor: 1.4, cap: 'x' }, 2: { from: 0, to: 1, floor: 0, cap: 1 }, x: { from: 0.5 }, 3: 'no' }
    const outputs = migrate({ version: 1, devices: { outputs: [{ ...toy, featureLevels: levels }, toy] } }).devices.outputs
    expect(outputs[0]?.featureLevels).toEqual({ 0: { from: 0.1, to: 0.6, floor: 0.2, cap: 0.8 }, 1: { from: 0.7, to: 0.7, floor: 1, cap: 1 } })
    expect(outputs[1]?.featureLevels).toBeUndefined()
  })
})

describe('stop on pause', () => {
  it('is on for a fresh install and a file from before it, and keeps an explicit choice', () => {
    expect(migrate(null).devices.stopOnPause).toBe(true)
    expect(migrate({ version: 1, devices: { outputs: [] } }).devices.stopOnPause).toBe(true)
    expect(migrate({ version: 1, devices: { outputs: [], stopOnPause: false } }).devices.stopOnPause).toBe(false)
    expect(migrate({ version: 1, devices: { stopOnPause: 'no' } }).devices.stopOnPause).toBe(true)
  })
})

describe('gooner and chaster', () => {
  it('start off, with nothing hidden and no token', () => {
    const s = migrate(null)
    expect(s.gooner.enabled).toBe(false)
    expect(s.gooner.lock).toBeNull()
    expect(s.chaster.token).toBe('')
  })

  it('keeps a lock across a restart and drops a malformed one', () => {
    expect(migrate({ version: 1, gooner: { enabled: true, lock: { kind: 'until', endsAt: 1234 } } }).gooner.lock).toEqual({ kind: 'until', endsAt: 1234 })
    expect(migrate({ version: 1, gooner: { lock: { kind: 'chaster' } } }).gooner.lock).toEqual({ kind: 'chaster' })
    expect(migrate({ version: 1, gooner: { lock: { kind: 'until' } } }).gooner.lock).toBeNull()
  })

  it('drops unknown kinds and falls back when none are left', () => {
    expect(migrate({ version: 1, gooner: { kinds: ['faces', 'hands'] } }).gooner.kinds).toEqual(['faces'])
    expect(migrate({ version: 1, gooner: { kinds: ['hands'] } }).gooner.kinds).toEqual(['genitals', 'breasts', 'buttocks'])
  })
})

describe('denial', () => {
  it('starts off, watching exposed genitals with no axis rules', () => {
    expect(migrate(null).denial).toEqual({ enabled: false, when: 'seen', kinds: ['genitals'], clothing: 'exposed', axes: {}, holdMs: 1500 })
  })

  it('keeps known axis rules, drops the rest and clamps the hold', () => {
    const d = migrate({ version: 1, denial: { enabled: true, when: 'unseen', clothing: 'either', axes: { L0: { action: 'slower', by: 2 }, V0: { action: 'nope' }, X9: { action: 'hold' }, R0: 'hold' }, holdMs: 99_000 } }).denial
    expect(d).toEqual({ enabled: true, when: 'unseen', kinds: ['genitals'], clothing: 'either', axes: { L0: { action: 'slower', by: 1 }, V0: { action: 'hold', by: 0.5 } }, holdMs: 30_000 })
  })
})

describe('remote source', () => {
  it('starts with no source and follow off', () => {
    expect(migrate(null).remote).toEqual({ enabled: false, port: 8420, source: '', follow: false, password: '', sourcePassword: '' })
  })

  it('normalises the address and keeps follow', () => {
    const remote = migrate({ version: 1, remote: { source: 'http://10.0.0.2/', follow: true } }).remote
    expect(remote.source).toBe('10.0.0.2:8420')
    expect(remote.follow).toBe(true)
  })
})

describe('first-start flow', () => {
  it('runs on a fresh install and stays off for a file from before it', () => {
    expect(migrate(null).general.setupDone).toBe(false)
    expect(migrate({ version: 1 }).general.setupDone).toBe(true)
    expect(migrate({ version: 1, general: { setupDone: false } }).general.setupDone).toBe(false)
  })
})


it('keeps per-video Hero music rules through the settings reader', () => {
  const heroMusic = { enabled: true, rules: { 3: { durationMs: 5000, tempo: 2, intensity: 1.2, playbackSpeed: 1.5, estimMax: 0.95 } } }
  const video = readPerVideo({ tracking: { heroMusic } })
  expect(video.tracking?.heroMusic).toEqual(heroMusic)
  expect(readPerVideo(JSON.parse(JSON.stringify(video))).tracking?.heroMusic).toEqual(heroMusic)
  expect(readPerVideo({ tracking: {} }).tracking?.heroMusic).toBeUndefined()
  expect(readPerVideo({ tracking: { heroMusic: { enabled: true, rules: { 0: null, 1: 'bad', 99: {} } } } }).tracking?.heroMusic).toEqual({ enabled: true, rules: {} })
})

it('keeps the output identity used by saved sessions across settings migrations', () => {
  const raw = { version: 1, devices: { outputs: [{ id: 'session-toy-1', kind: 'serial', profile: 'stroker', path: '/fictional' }] } }
  expect(migrate(migrate(raw)).devices.outputs[0]?.id).toBe('session-toy-1')
})

describe('theme', () => {
  it('starts dark with the original colours, keeps a choice and drops junk', () => {
    expect(migrate(null).appearance.theme).toEqual({ mode: 'dark', accent: 'violet', tint: 'none' })
    expect(migrate({ version: 1, appearance: { reduceTransparency: true } }).appearance.theme).toEqual({ mode: 'dark', accent: 'violet', tint: 'none' })
    const theme = { mode: 'light', accent: 'rose', tint: 'sky' }
    expect(migrate({ version: 1, appearance: { theme } }).appearance.theme).toEqual(theme)
    expect(migrate({ version: 1, appearance: { theme: { mode: 'sepia', accent: 7, tint: 'none' } } }).appearance.theme).toEqual({ mode: 'dark', accent: 'violet', tint: 'none' })
  })
})

import { expect, it } from 'vitest'
import { defaultSessionSetup } from './session'
import { sessionRun, sessionSetup } from './session-settings'
import { createTranslator } from './i18n'

it('translates missing session names and keeps names supplied by the user', () => {
  const t = createTranslator('en', { 'session.toys.toy': 'Appareil', 'player.queue.video': 'Vidéo', 'session.settings.pacing': 'Rythme' })
  const run = sessionRun({
    setup: { toys: { rules: [{ outputId: 'one' }, { outputId: 'two', name: 'My toy' }], periods: [{ outputId: 'one' }] } },
    totalMs: 1000,
    clips: [{ mediaId: 1, startMs: 0, endMs: 1000, intensity: null, phase: 0 }],
    phases: [{ startMs: 0, endMs: 1000, from: null, to: null }],
  }, t)
  expect(run?.setup.toys.rules.map((rule) => rule.name)).toEqual(['Appareil', 'My toy'])
  expect(run?.setup.toys.periods[0]?.name).toBe('Appareil')
  expect(run?.clips[0]?.title).toBe('Vidéo')
  expect(run?.phases[0]?.label).toBe('Rythme')
})

it('adds timeline defaults to remembered setups without losing existing pacing or sources', () => {
  const setup = sessionSetup({ entries: [{ role: 'include', ref: { kind: 'tag', name: 'Slow' } }], pacing: { kind: 'ramp', ramp: { from: 0.1, to: 0.8 } }, tracking: false })
  expect(setup.entries[0]?.ref).toEqual({ kind: 'tag', name: 'Slow' })
  expect(setup.pacing.ramp).toEqual({ from: 0.1, to: 0.8 })
  expect(setup).toMatchObject({ tracking: false, matchVideos: true, timeRules: [], toys: { enabled: false } })
})
it('bounds periods and output percentages, rejects unknown axes and drops output secrets', () => {
  const setup = sessionSetup({
    toys: { rules: [{ outputId: 'one', name: 'Toy', low: -4, high: 200, token: 'secret' }], periods: [{ outputId: 'one', from: -0.5, to: 5, scale: Infinity }] },
    requireAxes: ['L0', 'unknown'],
  })
  expect(setup.toys.rules[0]).toEqual({ outputId: 'one', name: 'Toy', low: 0, middle: 1, high: 1 })
  expect(setup.toys.periods[0]).toMatchObject({ from: 0, to: 1, scale: 1 })
  expect(setup.requireAxes).toEqual(['L0'])
})
it('rejects incomplete replays rather than manufacturing timings', () => {
  const run = {
    setup: defaultSessionSetup(),
    totalMs: 60000,
    clips: [{ mediaId: 1, title: 'Video', startMs: 1000, endMs: 61000, intensity: 0.5, axesOff: [], phase: 0 }],
    phases: [{ startMs: 0, endMs: 60000, from: 0.5, to: 0.5, hard: false, label: 'Pacing' }],
  }
  expect(sessionRun(run)?.clips).toEqual(run.clips)
  expect(sessionRun({ ...run, clips: [] })).toBeNull()
  expect(sessionRun({ ...run, clips: [{ ...run.clips[0], phase: 4 }] })).toBeNull()
  expect(sessionRun({ ...run, phases: [{ ...run.phases[0], startMs: 1000 }] })).toBeNull()
  expect(sessionRun({ ...run, totalMs: 90000 })).toBeNull()
  expect(sessionRun({ ...run, phases: [{ ...run.phases[0], endMs: 90000 }] })).toBeNull()
})

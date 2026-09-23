import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { GenerateState } from 'bp-engine'
import { SIGNED_OUT } from '@shared/account'
import { defaultTrackAxes } from '@shared/tracking'
import type { GenerateStep } from '@/state/generate'

const state = vi.hoisted(() => ({
  target: null as { title: string; tracking: { axes: ReturnType<typeof defaultTrackAxes>; heroZone: null } } | null,
  phase: 'plan' as 'plan' | 'running' | 'done' | 'error',
  open: true, steps: [] as GenerateStep[], progress: null as GenerateState | null,
  startedAt: 0, saved: null as string[] | null, scripts: null as { suffix: string; json: string }[] | null,
  error: null, start: vi.fn(), save: vi.fn(), openInEditor: vi.fn(), cancel: vi.fn(), close: vi.fn(),
}))
vi.mock('@/state/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state/account')>()
  return { ...actual, useAccount: Object.assign(<T>(select: (s: ReturnType<typeof actual.useAccount.getState>) => T) => select(actual.useAccount.getState()), actual.useAccount) }
})
vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/node', () => ({ electron: { shell: { openExternal: vi.fn() }, clipboard: { writeText: vi.fn() } } }))
vi.mock('@/state/generate', () => ({ useGenerate: (select: (s: typeof state) => unknown) => select(state) }))
vi.mock('@/state/player', () => ({ usePlayer: (select: (s: { title: string }) => unknown) => select({ title: 'Dance' }) }))
vi.mock('@/state/tracking', () => ({ useTracking: (select: (s: typeof tracking) => unknown) => select(tracking) }))
vi.mock('@/components/ui/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('section', {}, children) }))
import { useAccount } from '@/state/account'
import { GenerateDialog } from './GenerateDialog'

const tracking = { axes: defaultTrackAxes(), heroZone: null, beat: { model: { status: 'watching', percent: 42 } } }
const render = () => renderToStaticMarkup(createElement(GenerateDialog))
beforeEach(() => {
  useAccount.setState({ status: SIGNED_OUT })
  state.phase = 'plan'
  state.steps = []
  state.progress = null
  state.saved = null
  state.scripts = null
  tracking.axes = defaultTrackAxes()
  tracking.axes.L0.source = 'ai-music'
  tracking.axes.L2.source = 'ai-motion'
  tracking.axes.R0.source = 'off'
  state.target = { title: 'Dance', tracking: { axes: tracking.axes, heroZone: null } }
})

it('summarizes enabled axes using the existing axis and source names', () => {
  const html = render()
  expect(html).toContain('Current tracking setup')
  expect(html).toContain('Stroke</th><td>AI CH/PMV')
  expect(html).toContain('Sway</th><td>AI Motion')
  expect(html).not.toContain('Twist')
  expect(html).not.toContain('Load the detector')
})

it('shows music progress, then removes the bar while choosing where to save', () => {
  state.phase = 'running'
  state.progress = { status: 'music', timeMs: 0, durationMs: 0, frames: 0, fps: 0, hits: 0, modelMs: 0 }
  expect(render()).toContain('aria-valuenow="42"')
  state.steps = [{ id: 'save', label: 'Choose where to save', detail: null, status: 'running' }]
  expect(render()).toContain('Choose where to save')
  expect(render()).not.toContain('role="progressbar"')
})

it('reports the actual saved count and preserves partial failure details', () => {
  state.phase = 'done'
  state.saved = ['/Dance.funscript']
  state.steps = [{ id: 'audio', label: 'Analyse the audio', detail: 'No audio', status: 'failed' }]
  const html = render()
  expect(html).toContain('1 funscript')
  expect(html).toContain('Analyse the audio: No audio')
  expect(html).not.toContain('Export axes')
})

it('labels fallback video tracking without claiming excluded Hero work', () => {
  state.phase = 'running'
  state.progress = { status: 'running', timeMs: 4200, durationMs: 10000, frames: 100, fps: 60, hits: 0, modelMs: 0 }
  tracking.axes.L0.source = 'hero'
  state.steps = [{ id: 'video', label: 'Track motion', detail: null, status: 'running' }]
  expect(render()).toContain('role="status">Video</p>')
  state.steps.push({ id: 'motion', label: 'Load AI Motion', detail: null, status: 'done' })
  expect(render()).toContain('role="status">AI Motion · Video</p>')
})

it('offers optional support for free exports and hides it for subscribers and running exports', () => {
  const html = render()
  expect(html).toContain('Selling these scripts on Patreon or elsewhere?')
  expect(html).toContain('Copy credit')
  expect(html).toContain('https://kinkyraven.com/betterplayer')
  expect(html).not.toContain('gen-premium')
  useAccount.setState({ status: { ...SIGNED_OUT, state: 'in', me: { id: 'paid', email: '', name: '', friendCode: '', premium: true, admin: false } } })
  expect(render()).not.toContain('Selling these scripts')
  useAccount.setState({ status: SIGNED_OUT })
  state.phase = 'running'
  expect(render()).not.toContain('Selling these scripts')
})

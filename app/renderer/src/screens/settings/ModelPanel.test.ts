import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/node', () => ({ electron: {} }))
vi.mock('@/engine/client', () => ({ models: () => [] }))
const tracking = { present: { detector: false, motion: true, music: false }, motion: { status: 'none' }, music: null, state: null, refreshModels: async () => {} }
vi.mock('@/state/tracking', () => ({ useTracking: (select: (s: typeof tracking) => unknown) => select(tracking) }))
vi.mock('./SettingsSection', () => ({ SettingsAdvanced: ({ children }: { children: ReactNode }) => children }))
import { ModelPanel } from './ModelPanel'

it('Advanced: an AI model on disk but not loaded is Included, a missing one Off', () => {
  const html = renderToStaticMarkup(createElement(ModelPanel)).replaceAll('<!-- -->', '')
  const rows = [...html.matchAll(/<span class="lbl">([^<]*)<\/span><span class="spacer"><\/span><span class="sub">([^<]*)</g)]
  expect(rows.map(([, label, state]) => [label, state])).toEqual([
    ['Region model', 'Off'],
    ['AI Motion', 'Included'],
    ['AI CH/PMV', 'Off'],
  ])
})

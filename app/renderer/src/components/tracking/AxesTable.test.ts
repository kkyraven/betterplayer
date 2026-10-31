import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TRACK_AXIS_IDS, defaultTrackAxes, type TrackAxisId, type TrackSource } from '@shared/tracking'

vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/engine/client', () => ({ models: () => [] }))
vi.mock('@/state/tracking', () => ({ useTracking: (select: (s: { refreshModels: () => Promise<void> }) => unknown) => select({ refreshModels: async () => {} }) }))
import { AxesTable } from './AxesTable'

const auto = (source: TrackSource, over: Partial<Record<TrackAxisId, TrackSource>> = {}) =>
  Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, over[id] ?? source])) as Record<TrackAxisId, TrackSource>

const selects = (html: string) => html.match(/<select[\s\S]*?<\/select>/g) ?? []

describe('AxesTable', () => {
  it('video: Auto names the rule, Funscript on a scripted axis, and a pick is tinted', () => {
    const axes = defaultTrackAxes()
    axes.L0.source = 'beat'
    const html = renderToStaticMarkup(
      createElement(AxesTable, { mode: 'video', axes, onChange: () => {}, scripted: new Set(['L2']), rules: { auto: auto('ai-motion', { L2: 'off' }), picked: ['L0'] } }),
    )
    const [l0, l2, l1] = selects(html)
    expect(l0).toContain('class="select picked"')
    expect(l0).toMatch(/<option value="beat" selected="">Beat</)
    expect(l1).toMatch(/^<select class="select"/)
    expect(l1).toMatch(/<option value="auto" selected="">Auto · AI Motion</)
    expect(l2).toMatch(/<option value="auto" selected="">Auto · Funscript</)
    expect(html).toContain('All from L0')
  })

  it('defaults: an On switch per axis in place of the source, and no All from L0', () => {
    const html = renderToStaticMarkup(createElement(AxesTable, { mode: 'defaults', axes: defaultTrackAxes(), onChange: () => {} }))
    expect(selects(html)).toHaveLength(0)
    const on = [...html.matchAll(/<span class="axon"><button[^>]*aria-checked="(true|false)"/g)].map((m) => m[1])
    expect(on).toEqual(['true', 'true', 'true', 'true', 'true', 'false'])
    expect(html).not.toContain('All from L0')
    expect(html).toContain('<span class="axon"><button data-label="On"')
  })

  it("defaults: R0's intensity is a speed when the rule fills it with Beat, whatever the stored source", () => {
    const twist = (html: string) => [...html.matchAll(/<span class="stepper-v">([^<]*)</g)].at(-2)?.[1]
    const legacy = defaultTrackAxes()
    legacy.R0.source = 'beat'
    expect(twist(renderToStaticMarkup(createElement(AxesTable, { mode: 'defaults', axes: legacy, onChange: () => {} })))).toBe('50%')
    expect(twist(renderToStaticMarkup(createElement(AxesTable, { mode: 'defaults', axes: defaultTrackAxes(), onChange: () => {}, twistBeat: true })))).toBe('½×')
  })
})

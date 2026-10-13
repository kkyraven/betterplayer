import { createElement, type EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DownloadArchiveEntry } from '@shared/downloads'
const hooks = vi.hoisted(() => ({ effects: [] as EffectCallback[], focus: vi.fn() }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useEffect: (effect: EffectCallback) => hooks.effects.push(effect), useRef: (current: unknown) => current === null ? { current: { focus: hooks.focus } } : actual.useRef(current) }
})
vi.mock('@/state/downloads', () => ({ useDownloads: (select: (s: { unlock: () => Promise<boolean>; selectArchive: () => Promise<boolean> }) => unknown) => select({ unlock: vi.fn(), selectArchive: vi.fn() }) }))
import { ArchiveControls } from './ArchiveControls'
import type { ArchiveView } from './archiveView'

const render = (view: ArchiveView, active = true) => renderToStaticMarkup(createElement(ArchiveControls, { id: 'zip', view, active, onBackToTopic: vi.fn() }))
const entry = (id: string, kind: DownloadArchiveEntry['kind'], selected: boolean): DownloadArchiveEntry => ({ id, name: `${id}.${kind === 'video' ? 'mp4' : 'funscript'}`, kind, bytes: 10, selected })
const flushEffects = () => { for (const effect of hooks.effects.splice(0)) effect() }

beforeEach(() => { hooks.effects.length = 0; hooks.focus.mockClear() })

it('starts the password step empty with Unlock disabled and the topic one click away', () => {
  const html = render({ kind: 'password', wrong: true })
  expect(html).toMatch(/<input[^>]*type="password"[^>]*value=""/)
  expect(html).toMatch(/<button type="submit"[^>]*disabled=""/)
  expect(html).toContain('Back to topic')
  expect(html).toContain('Wrong password')
})

it('cannot import an empty selection and keeps the queue defaults checked', () => {
  const empty = render({ kind: 'select', entries: [entry('entry-1', 'video', false), entry('entry-2', 'video', false)] })
  expect(empty).toMatch(/download-archive-submit"[^>]*disabled=""/)
  const chosen = render({ kind: 'select', entries: [entry('entry-1', 'video', true), entry('entry-2', 'video', false), entry('entry-3', 'script', true)] })
  expect(chosen).not.toMatch(/download-archive-submit"[^>]*disabled=""/)
  expect(chosen.match(/checked=""/g)).toHaveLength(2)
})

it('focuses a remounted wrong-password field only when downloads are visible', () => {
  render({ kind: 'password', wrong: false })
  flushEffects()
  expect(hooks.focus).not.toHaveBeenCalled()
  render({ kind: 'password', wrong: true }, false)
  flushEffects()
  expect(hooks.focus).not.toHaveBeenCalled()
  expect(render({ kind: 'password', wrong: true })).toMatch(/<input[^>]*type="password"[^>]*value=""/)
  flushEffects()
  expect(hooks.focus).toHaveBeenCalledOnce()
  expect(render({ kind: 'password', wrong: true })).toMatch(/<input[^>]*type="password"[^>]*value=""/)
  flushEffects()
  expect(hooks.focus).toHaveBeenCalledTimes(2)
})

it('collapses published archive members and shows their count and saved names', () => {
  const html = render({ kind: 'published', entries: [{ ...entry('entry-1', 'video', true), publishedName: 'saved.mp4' }, entry('entry-2', 'script', true)] })
  expect(html).toContain('<details class="download-archive download-archive-published">')
  expect(html).toContain('<summary>Extracted files <span>2</span></summary>')
  expect(html).toContain('saved.mp4')
  expect(html).toContain('entry-2.funscript')
})

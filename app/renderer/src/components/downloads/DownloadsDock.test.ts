import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EroTopic } from '@shared/eroscripts'

const downloads = vi.hoisted(() => ({
  managerOpen: false,
  state: { session: { total: 0, attention: 0 } },
  setManagerOpen: vi.fn(),
}))

vi.mock('@/state/downloads', () => ({
  useDownloads: (select: (state: typeof downloads) => unknown) => select(downloads),
}))
vi.mock('@/screens/browser/TopicFiles', () => ({
  TopicFiles: ({ active }: { active: boolean }) => createElement('div', { 'data-child': 'topic-files', 'data-active': active }),
}))
vi.mock('./DownloadManager', () => ({
  DownloadManager: ({ active, embedded }: { active: boolean; embedded: boolean }) => createElement('div', { 'data-child': 'downloads', 'data-active': active, 'data-embedded': embedded }),
}))

import { DownloadsDock } from './DownloadsDock'

const topic: EroTopic = {
  tabId: 1, generation: 1, url: 'https://discuss.eroscripts.com/t/fixture/123',
  title: 'Calibration files', sources: [], scope: 'loaded-posts',
}

function render() {
  return renderToStaticMarkup(createElement(DownloadsDock, { topic, related: false }))
}

function element(html: string, id: string) {
  const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0]
  expect(tag, `Missing ${id}`).toBeDefined()
  return tag ?? ''
}

beforeEach(() => {
  downloads.managerOpen = false
  downloads.state.session.total = 0
  downloads.state.session.attention = 0
  downloads.setManagerOpen.mockReset()
})

describe('topic download dock', () => {
  it('exposes linked Files and Downloads tabs with only Files in the tab order initially', () => {
    const html = render()
    expect(html).toContain('role="tablist"')
    const files = element(html, 'ero-files-tab')
    const queue = element(html, 'ero-downloads-tab')
    expect(files).toContain('role="tab"')
    expect(files).toContain('aria-selected="true"')
    expect(files).toContain('tabindex="0"')
    expect(files).toContain('aria-controls="ero-files-panel"')
    expect(queue).toContain('role="tab"')
    expect(queue).toContain('aria-selected="false"')
    expect(queue).toContain('tabindex="-1"')
    expect(queue).toContain('aria-controls="ero-downloads-panel"')
    const filesPanel = element(html, 'ero-files-panel')
    const queuePanel = element(html, 'ero-downloads-panel')
    expect(filesPanel).toContain('role="tabpanel"')
    expect(filesPanel).toContain('aria-labelledby="ero-files-tab"')
    expect(filesPanel).not.toContain('hidden=')
    expect(queuePanel).toContain('role="tabpanel"')
    expect(queuePanel).toContain('aria-labelledby="ero-downloads-tab"')
    expect(queuePanel).toContain('hidden=""')
    expect(html).toContain('data-child="topic-files" data-active="true"')
    expect(html).toContain('data-child="downloads" data-active="false" data-embedded="true"')
  })

  it('keeps the Files panel mounted and inactive while Downloads is selected', () => {
    downloads.managerOpen = true
    downloads.state.session.total = 3
    downloads.state.session.attention = 1
    const html = render()
    expect(element(html, 'ero-files-tab')).toContain('aria-selected="false"')
    expect(element(html, 'ero-files-tab')).toContain('tabindex="-1"')
    expect(element(html, 'ero-downloads-tab')).toContain('aria-selected="true"')
    expect(element(html, 'ero-downloads-tab')).toContain('tabindex="0"')
    expect(element(html, 'ero-files-panel')).toContain('hidden=""')
    expect(element(html, 'ero-downloads-panel')).not.toContain('hidden=')
    expect(html).toContain('data-child="topic-files" data-active="false"')
    expect(html).toContain('data-child="downloads" data-active="true" data-embedded="true"')
  })

  it('keeps the empty Downloads tab available before a download starts', () => {
    const queue = element(render(), 'ero-downloads-tab')
    expect(queue).not.toContain('disabled=')
    expect(queue).not.toContain('hidden=')
  })
})

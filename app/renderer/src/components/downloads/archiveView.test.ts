import { describe, expect, it } from 'vitest'
import type { DownloadArchive, DownloadArchiveEntry, DownloadFile } from '@shared/downloads'
import { archiveView, selectedIds, toggleKind } from './archiveView'

const entry = (id: string, kind: DownloadArchiveEntry['kind'], selected = false, publishedName?: string): DownloadArchiveEntry => ({ id, name: `${id}.${kind === 'video' ? 'mp4' : 'funscript'}`, kind, bytes: 10, selected, publishedName })
const entries = [entry('entry-1', 'script'), entry('entry-2', 'video'), entry('entry-3', 'script'), entry('entry-4', 'video')]
const archive = (state: DownloadArchive['state'], list = entries): DownloadArchive => ({ state, entries: list, extractedBytes: 5, totalBytes: 20, skippedEntries: 0 })
const file = (phase: DownloadFile['phase'], value?: DownloadArchive): DownloadFile => ({ id: 'zip', batchId: 'batch', sourceId: 'source', fileName: 'pack.zip', publishedName: null, kind: 'archive', phase, host: 'example.test', receivedBytes: 1, totalBytes: 1, reason: null, attempts: [], canPause: false, canContinue: false, mediaId: null, archive: value })

describe('archive row view', () => {
  it('offers recovery only while the row is waiting', () => {
    expect(archiveView(file('waiting', archive('password-required')))).toEqual({ kind: 'password', wrong: false })
    expect(archiveView(file('waiting', archive('wrong-password')))).toEqual({ kind: 'password', wrong: true })
    for (const phase of ['failed', 'cancelled', 'complete', 'queued'] as const) {
      expect(archiveView(file(phase, archive('wrong-password')))?.kind).not.toBe('password')
      expect(archiveView(file(phase, archive('selection-required')))?.kind).not.toBe('select')
    }
  })

  it('lists every video and script without pairing them and keeps backend defaults', () => {
    const view = archiveView(file('waiting', archive('selection-required', [entry('entry-1', 'script', true), ...entries.slice(1)])))
    expect(view?.kind === 'select' && view.entries.map((item) => [item.id, item.selected])).toEqual([['entry-2', false], ['entry-4', false], ['entry-1', true], ['entry-3', false]])
  })

  it('shows only the selected files while extracting and their published names once complete', () => {
    const chosen = [entry('entry-1', 'script', true, 'pack.funscript'), entry('entry-2', 'video', true, 'pack.mp4'), entry('entry-4', 'video')]
    const progress = archiveView(file('extracting', archive('extracting', chosen)))
    expect(progress).toMatchObject({ kind: 'progress', extracting: true, extractedBytes: 5, totalBytes: 20 })
    expect(progress?.kind === 'progress' && progress.entries.map((item) => item.id)).toEqual(['entry-2', 'entry-1'])
    const done = archiveView(file('complete', archive('ready', chosen)))
    expect(done?.kind === 'published' && done.entries.map((item) => item.publishedName)).toEqual(['pack.mp4', 'pack.funscript'])
  })

  it('toggles one kind at a time and submits each id once', () => {
    const scripts = toggleKind(new Set(['entry-2']), entries, 'script', true)
    expect(selectedIds(scripts, entries)).toEqual(['entry-1', 'entry-2', 'entry-3'])
    expect(selectedIds(toggleKind(scripts, entries, 'video', false), entries)).toEqual(['entry-1', 'entry-3'])
  })
})

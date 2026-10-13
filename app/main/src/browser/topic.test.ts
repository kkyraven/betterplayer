import { describe, expect, it } from 'vitest'
import { MAX_TOPIC_SOURCES, explicitMirrorKind, sourceId, type EroSource } from '@shared/eroscripts'
import { topicReport } from './topic'

const url = 'https://discuss.eroscripts.com/t/test/123'
function source(overrides: Partial<EroSource> = {}): EroSource {
  return { id: 'untrusted', url: 'https://files.example/test.mp4', label: 'test.mp4', host: 'untrusted.example', kind: 'video', fileName: 'test.mp4', postNumber: 1, controlId: null, mirrorKey: null, ...overrides }
}
function report(sources = [source()]) { return { generation: 4, url, title: 'Test', scope: 'loaded-posts', sources } }

describe('EroScripts topic reports', () => {
  it('supplies tab identity and derives source identity and host in main', () => {
    const actual = topicReport(report(), 7, 4, url)
    expect(actual?.tabId).toBe(7)
    expect(actual?.sources[0]).toMatchObject({ id: sourceId(1, source().url), host: 'files.example', postNumber: 1 })
  })
  it('rejects stale generations, other pages and oversized payloads', () => {
    expect(topicReport(report(), 7, 5, url)).toBeNull()
    expect(topicReport(report(), 7, 4, 'https://discuss.eroscripts.com/search?q=test')).toBeNull()
    expect(topicReport({ ...report(), url: `${url}/2` }, 7, 4, url)).toBeNull()
    expect(topicReport(report(Array.from({ length: MAX_TOPIC_SOURCES + 1 }, () => source())), 7, 4, url)).toBeNull()
  })
  it('rejects local URLs, credentials and filename traversal', () => {
    for (const unsafe of ['file:///tmp/test.mp4', 'javascript:alert(1)', 'https://name:secret@files.example/test.mp4']) {
      expect(topicReport(report([source({ url: unsafe })]), 7, 4, url)).toBeNull()
    }
    expect(topicReport(report([source({ fileName: '../test.mp4' })]), 7, 4, url)).toBeNull()
  })
  it('only accepts generated controls scoped to the current topic', () => {
    expect(topicReport(report([source({ url, kind: 'script', fileName: 'test.max.funscript', controlId: 'ero-4-1' })]), 7, 4, url)?.sources).toHaveLength(1)
    expect(topicReport(report([source({ controlId: 'ero-4-1' })]), 7, 4, url)).toBeNull()
  })
  it('bounds author archive password hints without changing their bytes', () => {
    const zip = source({ kind: 'archive', fileName: 'pack.zip', archivePasswords: [' test+PW ', 'test+PW', ' test+PW '] })
    expect(topicReport(report([zip]), 7, 4, url)?.sources[0]?.archivePasswords).toEqual([' test+PW ', 'test+PW'])
    for (const archivePasswords of [Array(9).fill('test'), [''], ['test\0'], ['x'.repeat(257)], 'test']) {
      expect(topicReport({ ...report(), sources: [{ ...zip, archivePasswords }] }, 7, 4, url)).toBeNull()
    }
  })
  it('retains a consistent post mirror group and removes every ambiguous member', () => {
    const first = source({ mirrorKey: 'post-1-mirror-1' })
    const second = source({ url: 'https://mirror.example/test.mp4', mirrorKey: 'post-1-mirror-1' })
    expect(topicReport(report([first, second]), 7, 4, url)?.sources.map((item) => item.mirrorKey)).toEqual(['post-1-mirror-1', 'post-1-mirror-1'])
    const edition = source({ url: 'https://third.example/test-4k.mp4', fileName: 'test-4k.mp4', mirrorKey: 'post-1-mirror-1' })
    expect(topicReport(report([first, second, edition]), 7, 4, url)?.sources.map((item) => item.mirrorKey)).toEqual([null, null, null])
  })
})

describe('explicit creator mirror labels', () => {
  const mirrors = [source({ url: 'https://mega.nz/file/id#key', label: 'Mirror 1', kind: 'unknown', fileName: null }), source({ url: 'https://pixeldrain.com/u/id', label: 'Mirror 2', kind: 'unknown', fileName: null })]
  it('recognizes same-file video and script mirror lists', () => {
    expect(explicitMirrorKind('Video mirrors:', mirrors)).toBe('video')
    expect(explicitMirrorKind('Script mirrors', mirrors)).toBe('script')
    expect(explicitMirrorKind('Video mirrors', [mirrors[0]!, source({ label: 'Mirror 2' })])).toBe('video')
  })
  it('refuses unlabeled sources, differing editions, mixed file types and folders', () => {
    expect(explicitMirrorKind('Other sources', mirrors)).toBeNull()
    expect(explicitMirrorKind('Video mirrors', [mirrors[0]!, source({ label: '1080p edit', kind: 'unknown', fileName: null })])).toBeNull()
    expect(explicitMirrorKind('Video mirrors', [source(), source({ kind: 'script', fileName: 'test.funscript' })])).toBeNull()
    expect(explicitMirrorKind('Video mirrors', [mirrors[0]!, source({ url: 'https://mega.nz/folder/id#key', kind: 'unknown', fileName: null })])).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import type { EroTopic } from '@shared/eroscripts'
import { downloadDestination, downloadSelection } from './download-selection'

const topic: EroTopic = {
  tabId: 4, generation: 2, url: 'https://discuss.eroscripts.com/t/example/12', title: 'Example', scope: 'loaded-posts',
  sources: [{ id: 's1', url: 'https://pixeldrain.com/u/example#key', host: 'pixeldrain.com', label: 'Video', kind: 'video', fileName: 'example.mp4', postNumber: 1, controlId: null, mirrorKey: null }],
}
const request = { tabId: 4, generation: 2, sourceIds: ['s1'], destination: { rootId: 2, relativePath: '' } }

describe('download commands', () => {
  it('freezes current main-owned sources and ignores supplied URLs', () => {
    const selected = downloadSelection({ ...request, url: 'https://other.invalid/file' }, topic)
    expect(selected.sources[0]?.url).toBe(topic.sources[0]?.url)
    expect(selected.sources[0]).not.toBe(topic.sources[0])
    expect(selected.destination).not.toBe(request.destination)
  })
  it('rejects stale topic generations and unknown source IDs', () => {
    expect(() => downloadSelection({ ...request, generation: 1 }, topic)).toThrow()
    expect(() => downloadSelection({ ...request, sourceIds: ['s2'] }, topic)).toThrow()
    expect(() => downloadSelection(request, null)).toThrow()
  })
  it('uses only main-owned archive passwords and freezes their candidate lists', () => {
    const archiveTopic: EroTopic = { ...topic, sources: [{ ...topic.sources[0]!, kind: 'archive', fileName: 'pack.zip', archivePasswords: ['author-test'] }] }
    const selected = downloadSelection({ ...request, archivePasswords: ['injected-test'] }, archiveTopic)
    archiveTopic.sources[0]!.archivePasswords!.push('changed-test')
    expect(selected.sources[0]?.archivePasswords).toEqual(['author-test'])
    expect(selected.availableSources[0]?.archivePasswords).toEqual(['author-test'])
  })
  it('deduplicates repeated selections', () => {
    expect(downloadSelection({ ...request, sourceIds: ['s1', 's1'] }, topic).sources).toHaveLength(1)
  })
  it('rejects path traversal and malformed destinations', () => {
    for (const relativePath of ['../other', '/tmp', 'C:/tmp', 'folder\\other', 'folder/../other', './folder', 'bad\u0000name']) {
      expect(() => downloadDestination({ rootId: 1, relativePath })).toThrow()
    }
    expect(() => downloadDestination({ rootId: 0, relativePath: '' })).toThrow()
    expect(downloadDestination({ rootId: 1, relativePath: 'Scripts/VR' })).toEqual({ rootId: 1, relativePath: 'Scripts/VR' })
  })
})

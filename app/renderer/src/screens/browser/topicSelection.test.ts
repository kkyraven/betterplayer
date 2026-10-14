import { describe, expect, it } from 'vitest'
import type { EroSource } from '@shared/eroscripts'
import type { DownloadBatch, DownloadFile } from '@shared/downloads'
import { distinctTopicFiles, initialTopicSelection, scriptSets, topicFileSources, topicSourceJob, topicSourcesJob } from './topicSelection'

function source(id: string, kind: EroSource['kind'], fileName: string | null, mirrorKey: string | null = null): EroSource {
  return { id, kind, fileName, mirrorKey, url: `https://example.test/${id}`, host: 'example.test', label: id, postNumber: 1, controlId: null }
}

describe('topic file selection', () => {
  it('preselects an unambiguous named pair and a standalone script', () => {
    expect(initialTopicSelection([source('v', 'video', 'test.mp4'), source('s', 'script', 'test.funscript')])).toEqual(['v', 's'])
    expect(initialTopicSelection([source('s', 'script', 'test.funscript')])).toEqual(['s'])
  })

  it('preselects a video with every axis of its script set, but not two sets', () => {
    const axes = ['aria.funscript', 'aria.pitch.funscript', 'aria.roll.funscript'].map((name, index) => source(`s${index}`, 'script', name))
    expect(initialTopicSelection([source('v', 'video', 'aria.mp4'), ...axes])).toEqual(['v', 's0', 's1', 's2'])
    expect(initialTopicSelection([source('v', 'video', 'aria.mp4'), ...axes, source('o', 'script', 'other.funscript')])).toEqual([])
  })

  it('requires a choice for multiple editions or unproven pairing', () => {
    expect(initialTopicSelection([source('a', 'video', 'test-1080.mp4'), source('b', 'video', 'test-2160.mp4'), source('s', 'script', 'test.funscript')])).toEqual([])
    expect(initialTopicSelection([source('v', 'video', 'test-cut.mp4'), source('s', 'script', 'test.funscript')])).toEqual([])
    expect(initialTopicSelection([source('v', 'unknown', null), source('z', 'archive', 'test.zip')])).toEqual([])
  })

  it('treats verified mirrors as one file while keeping every different source available', () => {
    const sources = [source('first', 'video', 'test.mp4', 'verified-test'), source('mirror', 'video', 'test.mp4', 'verified-test'), source('unknown', 'unknown', null)]
    expect(distinctTopicFiles(sources).map((file) => file.id)).toEqual(['first', 'unknown'])
    expect(sources).toHaveLength(3)
    expect(initialTopicSelection(sources)).toEqual(['first'])
  })

  it('discloses verified mirrors without combining different kinds or unproven files', () => {
    const video = source('first', 'video', 'test.mp4', 'verified-test')
    const mirror = source('mirror', 'video', 'test.mp4', 'verified-test')
    const script = source('script', 'script', 'test.funscript', 'verified-test')
    const unknown = source('unknown', 'unknown', null)
    const another = source('another', 'unknown', null)
    const sources = [video, mirror, script, unknown, another]
    expect(topicFileSources(video, sources)).toEqual([video, mirror])
    expect(topicFileSources(script, sources)).toEqual([script])
    expect(topicFileSources(unknown, sources)).toEqual([unknown])
  })
})

describe('script sets', () => {
  it('groups axes under their stem with stroke first and names a repeated axis by its suffix', () => {
    const sets = scriptSets([
      source('pitch', 'script', 'Scene.One.pitch.funscript'),
      source('stroke', 'script', 'Scene.One.funscript'),
      source('max', 'script', 'Scene.One.max.funscript'),
      source('other', 'script', 'Other.funscript'),
      source('label', 'script', null),
    ], [source('v', 'video', 'Scene.One.mp4')])
    expect(sets.map((set) => [set.name, set.scripts.map((script) => [script.source.id, script.axis, script.variant])])).toEqual([
      ['Scene.One', [['stroke', 'L0', null], ['max', 'L0', 'max'], ['pitch', 'R2', null]]],
      ['Other', [['other', 'L0', null]]],
      ['label', [['label', 'L0', null]]],
    ])
  })
})

describe('topic source status', () => {
  const file: DownloadFile = { id: 'file', batchId: 'batch', sourceId: 'reused-script', fileName: 'speedtest.funscript', publishedName: 'video.funscript', kind: 'script', phase: 'complete', host: 'discuss.eroscripts.com', receivedBytes: 100, totalBytes: 100, reason: null, attempts: [], canPause: false, canContinue: false, mediaId: 1 }
  const batch: DownloadBatch = { id: 'batch', title: 'Test video', topicUrl: 'https://discuss.eroscripts.com/t/review/293158', topicTabId: 1, topicGeneration: 2, destination: { rootId: 1, relativePath: '' }, destinationName: 'Library', createdAt: 1, files: [file] }

  it('does not inherit completion for a reused script in another topic or from a browser download', () => {
    expect(topicSourceJob({ url: 'https://discuss.eroscripts.com/t/mini/313607' }, { id: 'reused-script' }, [batch])).toBeUndefined()
    expect(topicSourceJob({ url: batch.topicUrl }, { id: 'reused-script' }, [batch])?.file).toBe(file)
    expect(topicSourceJob({ url: batch.topicUrl }, { id: 'reused-script' }, [{ ...batch, origin: 'browser' }])).toBeUndefined()
  })

  it('retains the newest same-topic status across reply URLs, renamed slugs and mirror attempts', () => {
    const newer = { ...batch, id: 'newer', createdAt: 2, files: [{ ...file, id: 'mirror-file', sourceId: 'mirror', attempts: [{ sourceId: file.sourceId, host: file.host, outcome: 'failed' as const, reason: 'Unavailable', at: 1, tabId: null }] }] }
    for (const url of ['https://discuss.eroscripts.com/t/new-slug/293158/4?tracking=1#reply', 'https://discuss.eroscripts.com/t/293158/4']) {
      expect(topicSourceJob({ url }, { id: 'reused-script' }, [batch, newer])).toEqual({ file: newer.files[0], destinationName: 'Library' })
    }
  })

  it('shows the newest grouped-file job when a different mirror needs attention', () => {
    const waiting = { ...batch, id: 'waiting', createdAt: 2, destinationName: 'Other folder', files: [{ ...file, id: 'waiting-file', sourceId: 'mirror', phase: 'waiting' as const, attempts: [] }] }
    expect(topicSourcesJob({ url: batch.topicUrl }, [{ id: file.sourceId }, { id: 'mirror' }], [batch, waiting])).toEqual({ file: waiting.files[0], destinationName: 'Other folder' })
  })
})

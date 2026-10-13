import { describe, expect, it } from 'vitest'
import type { DownloadBatch, DownloadFile, DownloadSession } from '@shared/downloads'
import { canCancelDownload, downloadBatchGroup, downloadCountGeometry, downloadTone, fileProgress, orderedBatches, sessionTransferProgress } from './downloadPresentation'

const session: DownloadSession = { id: 'session', total: 6, completed: 2, failed: 0, cancelled: 0, active: 1, attention: 0, receivedBytes: 500, totalBytes: 1000, progress: .5 }
const file: DownloadFile = { id: 'file', batchId: 'batch', sourceId: 'source', fileName: 'test.mp4', publishedName: null, kind: 'video', phase: 'downloading', host: 'example.test', receivedBytes: 500, totalBytes: 1000, reason: null, attempts: [], canPause: true, canContinue: false, mediaId: null }
const batch = (id: string, createdAt: number, phases: DownloadFile['phase'][]): DownloadBatch => ({ id, title: id, topicUrl: 'https://example.test/topic', topicTabId: 1, topicGeneration: 1, destination: { rootId: 1, relativePath: '' }, destinationName: 'Downloads', createdAt, files: phases.map((phase, index) => ({ ...file, id: `${id}-${index}`, batchId: id, phase })) })

describe('download indicators', () => {
  it('preserves exact session counts and widens the tray for long counts', () => {
    expect(downloadCountGeometry(session)).toMatchObject({ count: '2/6', width: 19.1 })
    const long = downloadCountGeometry({ ...session, completed: 128, total: 130 })
    expect(long.count).toBe('128/130')
    expect(long.width).toBeGreaterThan(40)
    expect(long.tray).toContain(`H${(long.width - 3.5).toFixed(1)}`)
  })

  it('gives required attention priority and reserves green for every file finishing', () => {
    expect(downloadTone(session)).toBe('active')
    expect(downloadTone({ ...session, attention: 1 })).toBe('attention')
    expect(downloadTone({ ...session, active: 0, completed: 5, failed: 1 })).toBe('idle')
    expect(downloadTone({ ...session, active: 0, completed: 6 })).toBe('done')
    expect(downloadTone(session, ['queued', 'paused'])).toBe('idle')
    expect(downloadTone(session, ['staged', 'paused'])).toBe('idle')
    expect(downloadTone(session, ['paused', 'downloading'])).toBe('active')
    expect(downloadTone(session, ['paused', 'extracting'])).toBe('active')
  })

  it('uses actual byte progress and retains an unknown size without a percentage', () => {
    expect(fileProgress(file)).toBe(.5)
    expect(fileProgress({ ...file, totalBytes: null })).toBeNull()
    expect(fileProgress({ ...file, totalBytes: 0 })).toBeNull()
    expect(fileProgress({ ...file, receivedBytes: 1500 })).toBe(1)
  })

  it('allows cancellation of recoverable work but protects publication', () => {
    expect(canCancelDownload({ ...file, phase: 'waiting' })).toBe(true)
    expect(canCancelDownload({ ...file, phase: 'staged' })).toBe(true)
    expect(canCancelDownload({ ...file, phase: 'publishing' })).toBe(false)
    expect(canCancelDownload({ ...file, phase: 'importing' })).toBe(false)
    expect(canCancelDownload({ ...file, phase: 'complete' })).toBe(false)
  })

  it('puts recovery ahead of newer transfers and finished batches without changing the queue', () => {
    const batches = [batch('complete', 50, ['complete']), batch('active', 40, ['downloading']), batch('password', 10, ['complete', 'waiting']), batch('failed', 20, ['failed']), batch('cancelled', 30, ['cancelled'])]
    expect(orderedBatches(batches).map((item) => item.id)).toEqual(['failed', 'password', 'active', 'complete', 'cancelled'])
    expect(batches.map((item) => item.id)).toEqual(['complete', 'active', 'password', 'failed', 'cancelled'])
    expect(downloadBatchGroup(batch('partial', 0, ['complete', 'extracting']))).toBe('active')
    expect(downloadBatchGroup(batch('cancelled', 0, ['complete', 'cancelled']))).toBe('finished')
  })

  it('hides byte completion while archives need input or are still importing', () => {
    const state = { batches: [batch('archive', 0, ['waiting'])], session: { ...session, completed: 0, progress: 1 }, canClear: false, cancellable: 1 }
    expect(sessionTransferProgress(state)).toBeNull()
    expect(sessionTransferProgress({ ...state, batches: [batch('archive', 0, ['extracting', 'importing'])] })).toBeNull()
    expect(sessionTransferProgress({ ...state, batches: [batch('transfer', 0, ['downloading'])], session })).toBe(.5)
    expect(sessionTransferProgress({ ...state, batches: [batch('transfer', 0, ['downloading'])], session: { ...session, progress: null } })).toBeNull()
  })
})

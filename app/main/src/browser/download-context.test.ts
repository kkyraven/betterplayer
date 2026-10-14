import { describe, expect, it } from 'vitest'
import { downloadContextForNavigation, relatedNavigation, reusableDownload, type DownloadOwner, type RelatedDownloadContext } from './download-context'

const owner: DownloadOwner = {
  attemptId: 'attempt-1', fileId: 'file-1', sourceUrl: 'https://mega.nz/file/selected#key',
  topic: { tabId: 1, generation: 1, url: 'https://discuss.eroscripts.com/t/test/123', title: 'Test', sources: [], scope: 'loaded-posts' },
}

describe('provider download context', () => {
  it('restores the download context and reuses its source tab after login returns to the selected file', () => {
    const initial: RelatedDownloadContext = { ...owner, approvedUrl: null, approvedUntil: 0 }
    const login = 'https://mega.nz/login'
    const away = downloadContextForNavigation(owner, initial, login, 100)
    expect(away).toBeNull()
    expect(reusableDownload(owner, owner.fileId, owner.sourceUrl, login)).toBe(false)
    const returned = downloadContextForNavigation(owner, away, owner.sourceUrl, 100)
    expect(returned).toEqual(initial)
    expect(reusableDownload(owner, owner.fileId, owner.sourceUrl, owner.sourceUrl)).toBe(true)
  })

  it('keeps unrelated pages and other provider files outside the retained context', () => {
    for (const url of ['https://example.com/file/selected#key', 'https://mega.nz/file/other#key', 'https://mega.nz/folder/selected#key', 'about:blank']) {
      expect(downloadContextForNavigation(owner, null, url, 100)).toBeNull()
      expect(reusableDownload(owner, owner.fileId, owner.sourceUrl, url)).toBe(false)
    }
  })

  it('does not reuse a source tab for a different queue file or source', () => {
    expect(reusableDownload(owner, 'file-2', owner.sourceUrl, owner.sourceUrl)).toBe(false)
    expect(reusableDownload(owner, owner.fileId, 'https://mega.nz/file/other#key', owner.sourceUrl)).toBe(false)
    expect(reusableDownload(null, owner.fileId, owner.sourceUrl, owner.sourceUrl)).toBe(false)
  })

  it('preserves a bounded navigation approval only while the context remains active', () => {
    const target = 'https://provider.example/download'
    const approved: RelatedDownloadContext = { ...owner, approvedUrl: target, approvedUntil: 200 }
    expect(downloadContextForNavigation(owner, approved, target, 100)).toBe(approved)
    expect(downloadContextForNavigation(owner, approved, target, 200)).toBeNull()
    expect(downloadContextForNavigation(owner, null, target, 100)).toBeNull()
    expect(downloadContextForNavigation(owner, approved, `${target}/other`, 100)).toBeNull()
  })

  it('recognises the original Mega file across supported canonical routes', () => {
    expect(relatedNavigation(owner.sourceUrl, 'https://mega.co.nz/file/selected#key')).toBe(true)
    expect(relatedNavigation('https://mega.nz/#!selected!key', 'https://mega.io/file/selected#key')).toBe(true)
    expect(relatedNavigation(owner.sourceUrl, 'https://mega.nz/#!selected!key')).toBe(true)
  })

  it('keeps the existing Gofile and Pixeldrain source boundaries', () => {
    expect(relatedNavigation('https://gofile.io/d/selected', 'https://www.gofile.io/d/selected')).toBe(true)
    expect(relatedNavigation('https://gofile.io/d/selected', 'https://gofile.io/d/other')).toBe(false)
    expect(relatedNavigation('https://pixeldrain.com/u/selected?download', 'https://pixeldrain.com/u/selected?download')).toBe(true)
    expect(relatedNavigation('https://pixeldrain.com/u/selected?download', 'https://pixeldrain.com/u/selected')).toBe(false)
    expect(relatedNavigation(owner.sourceUrl, 'file:///file/selected')).toBe(false)
  })
})

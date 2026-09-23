import { describe, expect, it } from 'vitest'
import { funscriptStatus } from './status'

const now = new Date(2026, 8, 6, 12, 0).getTime()
const at = new Date(2026, 8, 6, 10, 41).getTime()

describe('funscriptStatus', () => {
  it('names the export and whether edits followed it', () => {
    expect(funscriptStatus(at, false, false, now)).toMatchObject({ key: 'editor.status.exported', when: expect.stringMatching(/^10:41/) })
    expect(funscriptStatus(at, true, true, now)).toMatchObject({ key: 'editor.status.behindExported', warn: true, off: false })
    expect(funscriptStatus(at, true, true, now).when).toMatch(/^10:41/)
  })
  it('shows a date for an export on another day', () => {
    const yesterday = new Date(2026, 8, 5, 10, 41).getTime()
    expect(funscriptStatus(yesterday, false, false, now).when).not.toMatch(/10:41/)
  })
  it('treats a file the document opened from as current until edited', () => {
    expect(funscriptStatus(null, true, false, now)).toEqual({ key: 'editor.status.onDisk', when: '', warn: false, off: false })
    expect(funscriptStatus(null, true, true, now)).toEqual({ key: 'editor.status.behind', when: '', warn: true, off: false })
  })
  it('is off with nothing on disk', () => {
    expect(funscriptStatus(null, false, true, now)).toEqual({ key: 'editor.status.notExported', when: '', warn: false, off: true })
  })
})

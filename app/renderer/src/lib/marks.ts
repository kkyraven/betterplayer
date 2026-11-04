import type { Bookmark, Chapter, ScriptInfo } from 'bp-engine'
import type { MediaMark } from '@shared/library'

export function scrubberMarks(scripts: readonly ScriptInfo[], marks: readonly MediaMark[] = []): { chapters: Chapter[]; bookmarks: Bookmark[] } {
  const selected = scripts.filter((s) => s.selected)
  return {
    chapters: [...selected.flatMap((s) => s.chapters), ...marks.flatMap((m) => (m.endMs === null ? [] : [{ name: m.name, startMs: m.startMs, endMs: m.endMs }]))],
    bookmarks: [...selected.flatMap((s) => s.bookmarks), ...marks.flatMap((m) => (m.endMs === null ? [{ name: m.name, atMs: m.startMs }] : []))],
  }
}

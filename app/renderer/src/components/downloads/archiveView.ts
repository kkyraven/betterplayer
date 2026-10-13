import type { DownloadArchiveEntry, DownloadFile } from '@shared/downloads'

export type ArchiveView =
  | { kind: 'password'; wrong: boolean }
  | { kind: 'select'; entries: DownloadArchiveEntry[] }
  | { kind: 'progress'; entries: DownloadArchiveEntry[]; extracting: boolean; extractedBytes: number; totalBytes: number }
  | { kind: 'published'; entries: DownloadArchiveEntry[] }

const AFTER_SELECTION = new Set<DownloadFile['phase']>(['extracting', 'staged', 'publishing', 'importing'])

export function archiveView(file: DownloadFile): ArchiveView | null {
  const archive = file.archive
  if (!archive) return null
  if (file.phase === 'waiting') {
    if (archive.state === 'password-required' || archive.state === 'wrong-password') return { kind: 'password', wrong: archive.state === 'wrong-password' }
    if (archive.state === 'selection-required' && archive.entries.length > 0) return { kind: 'select', entries: orderedEntries(archive.entries) }
    return null
  }
  if (AFTER_SELECTION.has(file.phase)) {
    const entries = orderedEntries(archive.entries.filter((entry) => entry.selected))
    return entries.length ? { kind: 'progress', entries, extracting: file.phase === 'extracting', extractedBytes: archive.extractedBytes, totalBytes: archive.totalBytes } : null
  }
  if (file.phase === 'complete') {
    const entries = orderedEntries(archive.entries.filter((entry) => entry.selected && entry.publishedName))
    return entries.length ? { kind: 'published', entries } : null
  }
  return null
}

export function orderedEntries(entries: readonly DownloadArchiveEntry[]): DownloadArchiveEntry[] {
  return [...entries.filter((entry) => entry.kind === 'video'), ...entries.filter((entry) => entry.kind === 'script')]
}

export function extractionProgress(view: { extractedBytes: number; totalBytes: number }): number | null {
  return view.totalBytes > 0 ? Math.min(1, Math.max(0, view.extractedBytes / view.totalBytes)) : null
}

export function toggleKind(selected: ReadonlySet<string>, entries: readonly DownloadArchiveEntry[], kind: DownloadArchiveEntry['kind'], on: boolean): Set<string> {
  const next = new Set(selected)
  for (const entry of entries) if (entry.kind === kind) {
    if (on) next.add(entry.id)
    else next.delete(entry.id)
  }
  return next
}

export function selectedIds(selected: ReadonlySet<string>, entries: readonly DownloadArchiveEntry[]): string[] {
  return entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.id)
}

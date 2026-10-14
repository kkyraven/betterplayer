import { isDownloadReason, type DownloadBatch, type DownloadFile, type DownloadPhase, type DownloadSession, type DownloadState } from '@shared/downloads'
import type { Translate } from '@shared/i18n'

const HOST_NAMES: Record<string, string> = {
  'mega.nz': 'MEGA', 'mega.co.nz': 'MEGA', 'mega.io': 'MEGA', 'gofile.io': 'GoFile', 'pixeldrain.com': 'Pixeldrain',
  'drive.google.com': 'Google Drive', 'dropbox.com': 'Dropbox', 'mediafire.com': 'MediaFire',
}
export function hostName(host: string): string {
  const bare = host.toLowerCase().replace(/^www\./, '')
  return HOST_NAMES[bare] ?? bare
}
export function reasonText(t: Translate, reason: string, host: string): string {
  return isDownloadReason(reason) ? t(reason, { host: hostName(host) }) : reason
}
export function manualStep(file: DownloadFile): boolean {
  return file.phase === 'waiting' && file.canContinue && !file.archive
}
export function canAttachFile(file: DownloadFile): boolean {
  return (file.phase === 'waiting' || file.phase === 'failed') && file.canRetry !== false && !file.archive
}

export function downloadTone(session: DownloadSession, phases?: DownloadPhase[]): 'attention' | 'active' | 'done' | 'idle' {
  if (session.attention > 0) return 'attention'
  if (phases ? phases.some((phase) => ['resolving', 'attempting', 'downloading', 'verifying', 'extracting', 'publishing', 'importing'].includes(phase)) : session.active > 0) return 'active'
  if (session.total > 0 && session.completed === session.total) return 'done'
  return 'idle'
}

export function downloadCountGeometry(session: DownloadSession) {
  const count = `${session.completed}/${session.total}`
  const width = Math.max(18, count.length * 5.7 + 2)
  return { count, width, tray: `M2.1 10.6V13.5a1.4 1.4 0 0 0 1.4 1.4H${(width - 3.5).toFixed(1)}a1.4 1.4 0 0 0 1.4-1.4V10.6` }
}

export function fileProgress(file: DownloadFile): number | null {
  return file.totalBytes && file.totalBytes > 0 ? Math.min(1, Math.max(0, file.receivedBytes / file.totalBytes)) : null
}

export function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`
}

export function canCancelDownload(file: DownloadFile): boolean {
  return !['complete', 'cancelled', 'publishing', 'importing'].includes(file.phase)
}

export type DownloadBatchGroup = 'attention' | 'active' | 'finished'

export function downloadBatchGroup(batch: DownloadBatch): DownloadBatchGroup {
  if (batch.files.some((file) => file.phase === 'waiting' || file.phase === 'failed')) return 'attention'
  return batch.files.some((file) => !['complete', 'cancelled'].includes(file.phase)) ? 'active' : 'finished'
}

export function orderedBatches(batches: DownloadBatch[]): DownloadBatch[] {
  const priority = { attention: 0, active: 1, finished: 2 }
  return [...batches].sort((a, b) => priority[downloadBatchGroup(a)] - priority[downloadBatchGroup(b)] || b.createdAt - a.createdAt)
}

export function sessionTransferProgress(state: DownloadState): number | null {
  return state.batches.some((batch) => batch.files.some((file) => file.phase === 'downloading')) ? state.session.progress : null
}

export interface FilesSummary {
  tone: 'idle' | 'active' | 'attention' | 'done'
  lead: DownloadFile | null
  receivedBytes: number
  totalBytes: number | null
  progress: number | null
}

export function summarizeFiles(files: readonly DownloadFile[]): FilesSummary {
  const live = files.filter((file) => file.phase !== 'cancelled')
  const attention = live.find((file) => file.phase === 'waiting' || file.phase === 'failed')
  const unfinished = live.filter((file) => file.phase !== 'complete')
  const receivedBytes = live.reduce((sum, file) => sum + file.receivedBytes, 0)
  const known = live.every((file) => file.phase === 'complete' || file.totalBytes !== null)
  const totalBytes = known ? live.reduce((sum, file) => sum + (file.totalBytes ?? file.receivedBytes), 0) : null
  const transferring = live.some((file) => file.phase === 'downloading')
  const tone = !live.length ? 'idle' : attention ? 'attention' : unfinished.length ? 'active' : 'done'
  return {
    tone,
    lead: attention ?? unfinished[0] ?? live[0] ?? null,
    receivedBytes,
    totalBytes,
    progress: transferring && totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
  }
}

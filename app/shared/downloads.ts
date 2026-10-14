import type { MessageKey } from './i18n'

export type DownloadPhase = 'queued' | 'resolving' | 'attempting' | 'downloading' | 'paused' | 'waiting' | 'verifying' | 'extracting' | 'staged' | 'publishing' | 'importing' | 'complete' | 'failed' | 'cancelled'
export type DownloadKind = 'video' | 'script' | 'archive' | 'unknown'
export interface DownloadDestination { rootId: number; relativePath: string }
export interface DownloadEnqueue {
  tabId: number
  generation: number
  sourceIds: string[]
  destination: DownloadDestination
  again?: boolean
}
export interface DownloadAttempt {
  id?: string
  host: string
  sourceId: string
  at: number
  outcome: 'starting' | 'waiting' | 'failed' | 'complete'
  reason: string | null
  tabId: number | null
}
export interface DownloadArchiveEntry {
  id: string
  name: string
  kind: 'video' | 'script'
  bytes: number
  selected: boolean
  publishedName?: string
}
export interface DownloadArchive {
  state: 'password-required' | 'wrong-password' | 'selection-required' | 'extracting' | 'ready'
  entries: DownloadArchiveEntry[]
  extractedBytes: number
  totalBytes: number
  skippedEntries: number
}
export interface DownloadFile {
  id: string
  batchId: string
  sourceId: string
  fileName: string
  publishedName: string | null
  kind: DownloadKind
  phase: DownloadPhase
  host: string
  receivedBytes: number
  totalBytes: number | null
  reason: string | null
  attempts: DownloadAttempt[]
  canPause: boolean
  canContinue: boolean
  mediaId: number | null
  canRetry?: boolean
  canOpenSource?: boolean
  archive?: DownloadArchive
}
export interface DownloadBatch {
  origin?: 'topic' | 'browser'
  savedPath?: string | null
  canImportVideoOnly?: boolean
  id: string
  title: string
  topicUrl: string
  topicTabId: number
  topicGeneration: number
  destination: DownloadDestination
  destinationName: string
  createdAt: number
  files: DownloadFile[]
}
export interface DownloadSession {
  id: string
  completed: number
  total: number
  failed: number
  cancelled: number
  active: number
  attention: number
  receivedBytes: number
  totalBytes: number | null
  progress: number | null
}
export interface DownloadState {
  batches: DownloadBatch[]
  session: DownloadSession
  canClear: boolean
  cancellable: number
}
export interface DownloadCommand { id: string }

export const DOWNLOAD_REASONS = [
  'downloads.reason.notStarted', 'downloads.reason.captcha', 'downloads.reason.limit', 'downloads.reason.chooseFile',
  'downloads.reason.fileKey', 'downloads.reason.linkPassword', 'downloads.reason.confirm', 'downloads.reason.unavailableNow',
  'downloads.reason.notLoaded', 'downloads.reason.tabClosed', 'downloads.reason.pageChanged', 'downloads.reason.differentFile',
  'downloads.reason.refreshTopic', 'downloads.reason.hostError', 'downloads.reason.busy', 'downloads.reason.interrupted',
  'downloads.reason.reselect', 'downloads.reason.trying', 'downloads.reason.unavailable',
] as const satisfies readonly MessageKey[]
export type DownloadReason = typeof DOWNLOAD_REASONS[number]
export function downloadKindOf(fileName: string): DownloadKind {
  return /\.funscript$/i.test(fileName) ? 'script' : /\.zip$/i.test(fileName) ? 'archive' : /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(fileName) ? 'video' : 'unknown'
}
export const isDownloadReason = (value: unknown): value is DownloadReason => DOWNLOAD_REASONS.some((reason) => reason === value)

export function waitingAttempt(file: Pick<DownloadFile, 'attempts' | 'sourceId'>): DownloadAttempt | undefined {
  return [...file.attempts].reverse().find((attempt) => attempt.sourceId === file.sourceId && attempt.outcome === 'waiting')
}

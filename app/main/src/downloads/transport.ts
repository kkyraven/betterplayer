import type { DownloadKind } from '@shared/downloads'
import type { DownloadItem } from 'electron'

export interface OrdinaryBrowserDownload { item: DownloadItem; tabId: number; pageUrl: string }

export interface DownloadCandidate {
  id: string
  url: string
  label: string
  host: string
  kind: DownloadKind
  fileName: string | null
  postNumber: number
  controlId: string | null
  mirrorKey: string | null
  archivePasswords?: string[]
}
export interface TransferProgress {
  receivedBytes: number
  totalBytes: number | null
  canPause?: boolean
}
export interface TransferRequest {
  attemptId: string
  fileId: string
  batchId: string
  topic: { tabId: number; generation: number; url: string }
  candidate: DownloadCandidate
  scriptFileNames?: readonly string[]
  directUrl: string | null
  stagingPath: string
  signal: AbortSignal
  onProgress: (progress: TransferProgress) => void
  onControl: (control: { pause: () => void; resume: () => void; cancel: () => void }) => void
}
export type TransferResult =
  | { status: 'complete'; fileName: string; totalBytes: number; mimeType?: string }
  | { status: 'waiting'; reason: string; tabId?: number }
  | { status: 'failed'; reason: string; scope: 'remote' | 'local'; unavailable?: boolean }
export type DownloadTransport = (request: TransferRequest) => Promise<TransferResult>

export interface TrustedDownloadSelection {
  topic: { tabId: number; generation: number; url: string; title: string }
  sources: DownloadCandidate[]
  availableSources: DownloadCandidate[]
  destination: { rootId: number; relativePath: string }
  again?: boolean
}

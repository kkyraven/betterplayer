import { randomUUID } from 'node:crypto'
import { link, lstat, open, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { DownloadBatch, DownloadDestination, DownloadFile, DownloadKind, DownloadState } from '@shared/downloads'
import { parseScriptName } from '@shared/matcher'
import { checkDestination, fullFileName, safeFileName, scriptNameParts, stagingDirectory, truncateFileStem, type CheckedDestination, type WritableRoot } from './files'
import { DownloadJournal, systemSecretCodec, type SecretCodec } from './journal'
import { VerificationError, verifyDownloaded } from './verify'
import { ArchiveError, extractArchive, inspectArchive } from './archive'
import type { DownloadCandidate, DownloadTransport, OrdinaryBrowserDownload, TransferRequest, TrustedDownloadSelection } from './transport'
import { resolveCloudSource } from './providers/cloud'
import { resolveWebSource } from './providers/web'

const TERMINAL = new Set(['complete', 'failed', 'cancelled'])
const FINISHING = new Set(['publishing', 'importing'])
const MAX_CANDIDATES = 8
const PHASES = new Set(['queued', 'resolving', 'attempting', 'downloading', 'paused', 'waiting', 'verifying', 'extracting', 'staged', 'publishing', 'importing', 'complete', 'failed', 'cancelled'])
interface PublicationFile {
  id: string
  fileName: string
  kind: DownloadKind
  stageName: string
  publishedName: string | null
  published: boolean
  archiveParentId?: string
  entryName?: string
  originalName?: string
}
interface ArchiveArtifact extends PublicationFile {
  entryId: string
  entryName: string
  archiveParentId: string
  kind: 'video' | 'script'
}
interface FileRecord extends DownloadFile {
  candidates: DownloadCandidate[]
  candidateIndex: number
  stageName: string
  sessionId: string
  groupId: string
  verified: boolean
  published: boolean
  dismissed: boolean
  browserOnly: boolean
  browserTriedSources: string[]
  originalName?: string
  archiveDownloaded?: boolean
  archiveArtifacts?: ArchiveArtifact[]
}
interface BatchRecord extends Omit<DownloadBatch, 'files'> {
  files: FileRecord[]
  checked: CheckedDestination
  stageDirectory: string
  sourceTopicUrl: string
}
interface ActiveTransfer {
  controller: AbortController
  attemptId: string
  control: { pause: () => void; resume: () => void; cancel: () => void } | null
  ordinary?: boolean
  host?: string
  ownsHost?: boolean
}
interface StoredQueue {
  version: 1
  batches: (Omit<BatchRecord, 'files' | 'sourceTopicUrl'> & { sealedTopicUrl: string | null; files: (Omit<FileRecord, 'candidates'> & { sealedCandidates: string | null })[] })[]
}
export interface DownloadQueueOptions {
  journalDir: string
  getRoot: (id: number) => WritableRoot | null | Promise<WritableRoot | null>
  transport: DownloadTransport
  importPublished: (batch: { id: string; destination: DownloadDestination; paths: string[]; files: { id: string; kind: DownloadKind; name: string }[] }) => Promise<{ mediaId: number | null }>
  onState: (state: DownloadState) => void
  continueAttempt?: (fileId: string, attemptId: string) => void | Promise<void>
  codec?: SecretCodec
  resolveSource?: (source: DownloadCandidate) => Promise<string | null> | string | null
  openOrdinarySource?: (url: string) => void | Promise<void>
}

function cleanTopic(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}
function eligible(preferred: DownloadCandidate, source: DownloadCandidate): boolean {
  if (source.id === preferred.id || source.kind !== preferred.kind) return false
  return preferred.mirrorKey !== null && source.mirrorKey === preferred.mirrorKey && (preferred.fileName === null || source.fileName === null || source.fileName === preferred.fileName)
}
function safeSource(source: DownloadCandidate): void {
  const url = new URL(source.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || source.url.length > 16_384 || !source.id || source.id.length > 300 || !Number.isSafeInteger(source.postNumber)) throw new Error('Invalid source')
  if (source.archivePasswords !== undefined && (!Array.isArray(source.archivePasswords) || source.archivePasswords.length > MAX_CANDIDATES || source.archivePasswords.some(password => typeof password !== 'string' || !password || password.length > 256))) throw new Error('Invalid archive password hints')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host.startsWith('[') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('Local network sources are not supported')
}
function copiedSource(source: DownloadCandidate): DownloadCandidate { return { ...source, archivePasswords: source.archivePasswords?.slice() } }
async function zipDownload(path: string, fileName: string, mimeType?: string): Promise<boolean> {
  const file = await open(path, 'r')
  const head = Buffer.alloc(512)
  let count: number
  try { count = (await file.read(head, 0, head.length, 0)).bytesRead } finally { await file.close() }
  const signature = count >= 4 ? head.readUInt32LE(0) : 0
  const zip = [0x04034b50, 0x06054b50, 0x08074b50].includes(signature)
  if (!zip && /\.zip$/i.test(fileName)) {
    if (/text\/html/i.test(mimeType ?? '') || /^\s*(<!doctype\s+html|<html|<head|<body)/i.test(head.subarray(0, count).toString('utf8'))) throw new VerificationError('The host returned a webpage')
    throw new VerificationError('Invalid ZIP archive')
  }
  return zip
}
function publicationFiles(files: FileRecord[]): PublicationFile[] { return files.flatMap<PublicationFile>(file => file.archiveArtifacts?.length ? file.archiveArtifacts : [file]) }
function findDirect(source: DownloadCandidate): string | null {
  if (source.controlId) return null
  const cloud = resolveCloudSource(source.url)
  if (cloud) return cloud.directUrl
  const web = resolveWebSource(source.url)
  if (web) return web.directUrl
  const url = new URL(source.url)
  return /\.(funscript|zip|mp4|m4v|mov|webm|mkv|avi)$/i.test(url.pathname) ? source.url : null
}
function browserFallback(source: DownloadCandidate): boolean {
  const cloud = resolveCloudSource(source.url)
  if (!cloud?.directUrl || source.controlId) return false
  const url = new URL(source.url)
  return /^(?:www\.)?pixeldrain\.com$/.test(url.hostname) ? /^\/u\//.test(url.pathname) : /^(?:www\.)?dropbox\.com$/.test(url.hostname)
}
function originalScriptStem(name: string, lowercaseStems: ReadonlySet<string>): string {
  const base = basename(name, extname(name))
  const prefixes = new Set<string>()
  if (lowercaseStems.has(base.toLowerCase())) prefixes.add(base)
  for (let index = 1; index < base.length; index++) {
    if (base[index] !== '.' && base[index] !== '_' && base.slice(index, index + 2) !== ' (' && !(base[index] === '-' && /^(max|plus)(?:\.|$)/i.test(base.slice(index + 1)))) continue
    const prefix = base.slice(0, index)
    if (lowercaseStems.has(prefix.toLowerCase())) prefixes.add(prefix)
  }
  return prefixes.size ? parseScriptName(name, prefixes)?.stem ?? scriptNameParts(name).stem : scriptNameParts(name).stem
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function safeStoredName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { return safeFileName(value) === value } catch { return false }
}
function safeEntryName(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 4096 && !/[\\\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
}
function validArchive(value: unknown): boolean {
  if (value === undefined) return true
  if (!record(value) || !['password-required', 'wrong-password', 'selection-required', 'extracting', 'ready'].includes(String(value.state)) || !Array.isArray(value.entries) || value.entries.length > 2048 || !Number.isSafeInteger(value.extractedBytes) || !Number.isSafeInteger(value.totalBytes) || !Number.isSafeInteger(value.skippedEntries) || Number(value.extractedBytes) < 0 || Number(value.totalBytes) < 0 || Number(value.skippedEntries) < 0) return false
  const ids = new Set<string>()
  return value.entries.every((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== 'string' || !/^entry-\d{1,5}$/.test(entry.id) || ids.has(entry.id) || !safeEntryName(entry.name) || !['video', 'script'].includes(String(entry.kind)) || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) <= 0 || typeof entry.selected !== 'boolean' || (entry.publishedName !== undefined && !safeStoredName(entry.publishedName))) return false
    ids.add(entry.id); return true
  })
}
function validArtifacts(value: unknown, parentId: string): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 2048) return false
  const ids = new Set<string>()
  const stages = new Set<string>()
  return value.every((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(entry.id) || ids.has(entry.id) || typeof entry.stageName !== 'string' || !/^[a-f0-9-]{36}$/i.test(entry.stageName) || stages.has(entry.stageName) || entry.archiveParentId !== parentId || typeof entry.entryId !== 'string' || !/^entry-\d{1,5}$/.test(entry.entryId) || !safeEntryName(entry.entryName) || !safeStoredName(entry.fileName) || !['video', 'script'].includes(String(entry.kind)) || typeof entry.published !== 'boolean' || (entry.publishedName !== null && !safeStoredName(entry.publishedName))) return false
    ids.add(entry.id); stages.add(entry.stageName); return true
  })
}
function storedQueue(value: unknown): value is StoredQueue {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('batches' in value) || !Array.isArray(value.batches) || value.batches.length > 10_000) return false
  return value.batches.every((batch: unknown) => {
    if (!batch || typeof batch !== 'object' || !('id' in batch) || typeof batch.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(batch.id) || !('files' in batch) || !Array.isArray(batch.files) || !('checked' in batch) || !batch.checked || typeof batch.checked !== 'object' || !('rootPath' in batch.checked) || typeof batch.checked.rootPath !== 'string' || !('directory' in batch.checked) || typeof batch.checked.directory !== 'string' || !('destination' in batch) || !batch.destination || typeof batch.destination !== 'object' || !('rootId' in batch.destination) || !Number.isSafeInteger(batch.destination.rootId) || !('relativePath' in batch.destination) || typeof batch.destination.relativePath !== 'string') return false
    return batch.files.length < 1000 && batch.files.every((file: unknown) => {
      if (!file || typeof file !== 'object' || !('id' in file) || typeof file.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(file.id)
        || !('batchId' in file) || file.batchId !== batch.id || !('phase' in file) || typeof file.phase !== 'string' || !PHASES.has(file.phase)
        || !('stageName' in file) || typeof file.stageName !== 'string' || !/^[a-f0-9-]{36}$/i.test(file.stageName)
        || !('fileName' in file) || typeof file.fileName !== 'string' || !file.fileName || basename(file.fileName) !== file.fileName || /[\\\x00-\x1f]/.test(file.fileName)
        || !('publishedName' in file) || (file.publishedName !== null && (typeof file.publishedName !== 'string' || basename(file.publishedName) !== file.publishedName || /[\\\x00-\x1f]/.test(file.publishedName)))
        || !('kind' in file) || !['script', 'video', 'archive', 'unknown'].includes(String(file.kind))
        || !('receivedBytes' in file) || typeof file.receivedBytes !== 'number' || !Number.isSafeInteger(file.receivedBytes) || file.receivedBytes < 0
        || !('totalBytes' in file) || (file.totalBytes !== null && (typeof file.totalBytes !== 'number' || !Number.isSafeInteger(file.totalBytes) || file.totalBytes < 0))
        || !('candidateIndex' in file) || typeof file.candidateIndex !== 'number' || !Number.isSafeInteger(file.candidateIndex) || file.candidateIndex < 0 || file.candidateIndex >= MAX_CANDIDATES
        || !('verified' in file) || typeof file.verified !== 'boolean' || !('published' in file) || typeof file.published !== 'boolean'
        || !('attempts' in file) || !Array.isArray(file.attempts) || file.attempts.length > 1000
        || ('originalName' in file && (typeof file.originalName !== 'string' || file.originalName.length > 4096 || basename(file.originalName) !== file.originalName || /[\\\x00-\x1f]/.test(file.originalName)))
        || ('archiveDownloaded' in file && typeof file.archiveDownloaded !== 'boolean') || !validArchive('archive' in file ? file.archive : undefined) || !validArtifacts('archiveArtifacts' in file ? file.archiveArtifacts : undefined, file.id)) return false
      return true
    })
  })
}

export class DownloadQueue {
  private readonly journal: DownloadJournal
  private readonly codec: SecretCodec
  private readonly sessionId = randomUUID()
  private groupId = randomUUID()
  private batches: BatchRecord[] = []
  private readonly active = new Map<string, ActiveTransfer>()
  private readonly hosts = new Set<string>()
  private readonly hostWaiters = new Set<() => void>()
  private readonly committing = new Set<string>()
  private readonly work = new Set<Promise<void>>()
  private readonly ordinaryItems = new WeakSet<OrdinaryBrowserDownload['item']>()
  private readonly ordinaryCleanups = new Set<() => void>()
  private readonly archivePasswords = new Map<string, string>()
  private readonly ordinaryResumptions = new Map<string, { url: string; expiresAt: number }>()
  private closed = false
  private emission: ReturnType<typeof setTimeout> | null = null
  private commandTail: Promise<unknown> = Promise.resolve()

  private constructor(private readonly options: DownloadQueueOptions) {
    this.journal = new DownloadJournal(options.journalDir)
    this.codec = options.codec ?? systemSecretCodec
  }
  static async open(options: DownloadQueueOptions): Promise<DownloadQueue> {
    const queue = new DownloadQueue(options)
    const saved = await queue.journal.load()
    if (saved !== null) {
      if (!storedQueue(saved)) throw new Error('Invalid download recovery journal')
      for (const raw of saved.batches) {
        const files: FileRecord[] = raw.files.map(({ sealedCandidates, ...file }) => {
          let candidates: DownloadCandidate[] = []
          try {
            const text = sealedCandidates === null ? null : queue.codec.unseal(sealedCandidates)
            if (text) {
              const parsed: unknown = JSON.parse(text)
              if (Array.isArray(parsed) && parsed.length <= MAX_CANDIDATES) {
                candidates = parsed.filter((candidate: unknown): candidate is DownloadCandidate => candidate !== null && typeof candidate === 'object' && 'url' in candidate && typeof candidate.url === 'string' && 'id' in candidate && typeof candidate.id === 'string' && 'host' in candidate && typeof candidate.host === 'string')
                candidates.forEach(safeSource)
              }
            }
          } catch { candidates = [] }
          return { ...file, archiveDownloaded: file.archiveDownloaded ?? false, archiveArtifacts: file.archiveArtifacts ?? [], canPause: false, browserOnly: file.browserOnly ?? false, browserTriedSources: file.browserTriedSources ?? [], candidates }
        })
        const { sealedTopicUrl, ...metadata } = raw
        const sourceTopicUrl = sealedTopicUrl ? queue.codec.unseal(sealedTopicUrl) ?? raw.topicUrl : raw.topicUrl
        const batch = { ...metadata, sourceTopicUrl, files }
        batch.stageDirectory = join(batch.checked.directory, `.bp-downloads-${batch.id}`)
        const recovering = files.some(file => !TERMINAL.has(file.phase))
        for (const file of files) {
          if (!TERMINAL.has(file.phase) || (recovering && file.phase === 'failed')) {
            file.sessionId = queue.sessionId
            file.groupId = queue.groupId
            if (batch.origin === 'browser') { file.phase = 'waiting'; file.reason = 'Browser download interrupted. Continue from its source'; file.canContinue = candidatesPresent(file); continue }
            if (file.phase === 'verifying') {
              try {
                await checkDestination(await queue.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
                if (await zipDownload(join(batch.stageDirectory, file.stageName), file.fileName)) {
                  file.archiveDownloaded = true; file.kind = 'archive'
                  file.receivedBytes = (await stat(join(batch.stageDirectory, file.stageName))).size; file.totalBytes = file.receivedBytes
                }
              } catch { }
            }
            if (file.kind === 'archive' && file.verified && !file.archiveArtifacts?.length && !file.published) {
              file.archiveDownloaded = true; file.verified = false
            }
            if (file.phase === 'paused') continue
            if (file.archiveDownloaded && !file.verified) { file.phase = 'queued'; file.reason = 'Extracting saved archive'; file.canContinue = false }
            else if (file.published) { file.phase = 'importing'; file.verified = true }
            else if (file.verified) file.phase = 'staged'
            else if (!candidatesPresent(file)) { file.phase = 'waiting'; file.reason = 'Source details unavailable after restart'; file.canContinue = false }
            else { file.phase = 'queued'; file.reason = 'Resuming after restart'; file.receivedBytes = 0; file.totalBytes = null }
          }
        }
        queue.batches.push(batch)
        if (batch.origin !== 'browser' && files.some(file => file.phase === 'complete')) await queue.cleanupImported(batch, files.filter(file => file.phase === 'complete'))
      }
    }
    await queue.persist()
    queue.emit()
    queue.schedule()
    for (const batch of queue.batches) if (batch.files.some(file => file.phase === 'staged' || file.phase === 'importing')) void queue.startFinishBatch(batch)
    return queue
  }

  state(): DownloadState {
    const all = this.batches.flatMap(batch => batch.files)
    const session = all.filter(file => file.sessionId === this.sessionId)
    const group = session.filter(file => file.groupId === this.groupId && file.phase !== 'cancelled')
    const unknown = group.some(file => file.totalBytes === null && file.phase !== 'complete')
    const totalBytes = unknown ? null : group.reduce((sum, file) => sum + (file.totalBytes ?? file.receivedBytes), 0)
    const receivedBytes = group.reduce((sum, file) => sum + Math.min(file.receivedBytes, file.totalBytes ?? file.receivedBytes), 0)
    return {
      batches: this.batches.filter(batch => batch.files.some(file => !file.dismissed)).map(batch => ({ id: batch.id, origin: batch.origin ?? 'topic', savedPath: batch.savedPath ?? null, canImportVideoOnly: batch.origin !== 'browser' && !this.committing.has(batch.id) && batch.files.some(file => file.kind === 'video' && file.verified && file.phase === 'staged') && batch.files.some(file => file.kind !== 'video' && ['failed', 'waiting', 'paused', 'cancelled'].includes(file.phase)), title: batch.title, topicUrl: batch.topicUrl, topicTabId: batch.topicTabId, topicGeneration: batch.topicGeneration, destination: { ...batch.destination }, destinationName: batch.destinationName, createdAt: batch.createdAt, files: batch.files.filter(file => !file.dismissed).map(file => ({ id: file.id, batchId: file.batchId, sourceId: file.sourceId, fileName: file.fileName, publishedName: file.publishedName, kind: file.kind, phase: file.phase, host: file.host, receivedBytes: file.receivedBytes, totalBytes: file.totalBytes, reason: file.reason, attempts: file.attempts.map(attempt => ({ ...attempt })), canPause: file.canPause, canContinue: file.canContinue, canRetry: batch.origin !== 'browser', mediaId: file.mediaId, archive: file.archive ? { ...file.archive, entries: file.archive.entries.map(entry => ({ ...entry })) } : undefined })) })),
      session: { id: this.sessionId, completed: session.filter(file => file.phase === 'complete').length, total: session.length, failed: session.filter(file => file.phase === 'failed').length, cancelled: session.filter(file => file.phase === 'cancelled').length, active: session.filter(file => !TERMINAL.has(file.phase)).length, attention: all.filter(file => !file.dismissed && (file.phase === 'failed' || file.phase === 'waiting')).length, receivedBytes, totalBytes, progress: totalBytes === null || totalBytes === 0 ? null : Math.min(1, receivedBytes / totalBytes) },
      canClear: this.batches.some(batch => batch.files.every(file => TERMINAL.has(file.phase)) && batch.files.some(file => !file.dismissed)),
      cancellable: this.batches.filter(batch => batch.files.some(file => !TERMINAL.has(file.phase))).flatMap(batch => batch.files).filter(file => file.phase !== 'complete' && file.phase !== 'cancelled' && !FINISHING.has(file.phase)).length,
    }
  }

  enqueue(selection: TrustedDownloadSelection): Promise<string> {
    return this.command(async () => {
      if (!selection.sources.length || selection.sources.length > 100 || selection.availableSources.length > 500 || !Number.isSafeInteger(selection.topic.tabId) || !Number.isSafeInteger(selection.topic.generation)) throw new Error('Invalid download selection')
      selection.sources.forEach(safeSource)
      selection.availableSources.forEach(safeSource)
      const chosen: DownloadCandidate[] = []
      for (const source of selection.sources) if (!chosen.some(other => other.id === source.id || eligible(other, source))) chosen.push(copiedSource(source))
      if (!selection.again) {
        const duplicate = this.batches.find(batch => batch.topicUrl === cleanTopic(selection.topic.url) && batch.destination.rootId === selection.destination.rootId && batch.destination.relativePath === selection.destination.relativePath && batch.files.some(file => file.phase !== 'cancelled') && batch.files.length === chosen.length && batch.files.every(file => chosen.some(source => file.candidates.some(candidate => candidate.id === source.id))))
        if (duplicate) {
          if (duplicate.files.some(file => file.dismissed)) { duplicate.files.forEach(file => { file.dismissed = false }); await this.changed() }
          return duplicate.id
        }
      }
      const root = await this.options.getRoot(selection.destination.rootId)
      const checked = await checkDestination(root, selection.destination)
      const id = randomUUID()
      const directory = await stagingDirectory(checked, id)
      if (!this.batches.flatMap(batch => batch.files).some(file => file.sessionId === this.sessionId && !TERMINAL.has(file.phase))) this.groupId = randomUUID()
      const files = chosen.map((source): FileRecord => ({ id: randomUUID(), batchId: id, sourceId: source.id, fileName: source.fileName ? safeFileName(source.fileName) : 'Download', publishedName: null, kind: source.kind, phase: 'queued', host: source.host, receivedBytes: 0, totalBytes: null, reason: null, attempts: [], canPause: false, canContinue: false, mediaId: null, candidates: [copiedSource(source), ...selection.availableSources.filter(candidate => eligible(source, candidate)).slice(0, MAX_CANDIDATES - 1).map(copiedSource)], candidateIndex: 0, stageName: randomUUID(), sessionId: this.sessionId, groupId: this.groupId, verified: false, published: false, dismissed: false, browserOnly: false, browserTriedSources: [] }))
      this.batches.push({ id, title: selection.topic.title.slice(0, 500), topicUrl: cleanTopic(selection.topic.url), sourceTopicUrl: selection.topic.url, topicTabId: selection.topic.tabId, topicGeneration: selection.topic.generation, destination: { ...selection.destination }, destinationName: root?.name || basename(checked.directory), createdAt: Date.now(), files, checked, stageDirectory: directory })
      await this.persist()
      this.emit()
      this.schedule()
      return id
    })
  }

  adoptOrdinary(download: OrdinaryBrowserDownload): void {
    if (this.closed || this.ordinaryItems.has(download.item)) return
    const item = download.item
    this.ordinaryItems.add(item)
    let record: FileRecord | null = null
    let batch: BatchRecord | null = null
    let accepting: Promise<void> | null = null
    let finished = false
    const accept = (): Promise<void> => {
      if (accepting) return accepting
      const savedPath = item.getSavePath()
      if (!savedPath || !isAbsolute(savedPath) || savedPath.includes('\0')) return Promise.resolve()
      if (!this.batches.flatMap(existing => existing.files).some(file => file.sessionId === this.sessionId && !TERMINAL.has(file.phase))) this.groupId = randomUUID()
      const fileName = basename(savedPath)
      const kind: DownloadKind = /\.funscript$/i.test(fileName) ? 'script' : /\.zip$/i.test(fileName) ? 'archive' : /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(fileName) ? 'video' : 'unknown'
      const sourceLink = /^https?:\/\//i.test(item.getURL()) ? item.getURL() : download.pageUrl
      let source: DownloadCandidate | null = null
      try {
        const url = new URL(sourceLink)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) source = { id: randomUUID(), url: sourceLink, label: fileName, host: url.hostname, kind, fileName, postNumber: 0, controlId: null, mirrorKey: null }
      } catch { }
      const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [item.getURL()]
      const resumptions = [...this.ordinaryResumptions].filter(([fileId, intent]) => {
        if (intent.expiresAt < Date.now()) { this.ordinaryResumptions.delete(fileId); return false }
        return chain.includes(intent.url)
      })
      if (resumptions.length === 1) {
        const fileId = resumptions[0]![0]
        this.ordinaryResumptions.delete(fileId)
        const previous = this.batches.find(existing => existing.origin === 'browser' && existing.files.some(file => file.id === fileId && file.phase === 'waiting'))
        const previousFile = previous?.files.find(file => file.id === fileId)
        if (previous && previousFile) {
          if (previous.savedPath === savedPath) { batch = previous; record = previousFile }
          else { previousFile.phase = 'cancelled'; previousFile.canContinue = false; previousFile.reason = null }
        }
      }
      const transferHost = source?.host ?? 'Browser'
      const queued = this.runningCount() >= 2 || this.hosts.has(transferHost)
      if (record && batch) {
        Object.assign(record, { phase: queued ? 'queued' : 'downloading', host: transferHost, receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null, reason: null, canPause: !queued, canContinue: false, verified: false, published: false, dismissed: false })
        batch.topicTabId = download.tabId
      } else {
        const id = randomUUID()
        const fileId = randomUUID()
        if (source) source.id = fileId
        record = { id: fileId, batchId: id, sourceId: fileId, fileName, publishedName: fileName, kind, phase: queued ? 'queued' : 'downloading', host: transferHost, receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null, reason: null, attempts: [], canPause: !queued, canContinue: false, mediaId: null, candidates: source ? [source] : [], candidateIndex: 0, stageName: randomUUID(), sessionId: this.sessionId, groupId: this.groupId, verified: false, published: false, dismissed: false, browserOnly: false, browserTriedSources: [] }
        const topicUrl = source ? cleanTopic(source.url) : ''
        batch = { id, origin: 'browser', savedPath, title: fileName, topicUrl, sourceTopicUrl: sourceLink, topicTabId: download.tabId, topicGeneration: 0, destination: { rootId: 0, relativePath: '' }, destinationName: dirname(savedPath), createdAt: Date.now(), files: [record], checked: { rootPath: dirname(savedPath), directory: dirname(savedPath) }, stageDirectory: '' }
        this.batches.push(batch)
      }
      const controller = new AbortController()
      const control = { pause: () => item.pause(), resume: () => item.resume(), cancel: () => item.cancel() }
      this.active.set(record.id, { controller, attemptId: record.id, control, ordinary: true, host: transferHost, ownsHost: !queued })
      if (!queued) this.hosts.add(transferHost)
      accepting = this.changed()
      this.track(accepting)
      if (queued && item.getState() === 'progressing') control.pause()
      return accepting
    }
    const progress = () => {
      void accept().then(() => {
        if (!record || finished || this.closed || this.interrupted(record)) return
        record.receivedBytes = Math.max(0, item.getReceivedBytes())
        record.totalBytes = item.getTotalBytes() > 0 ? item.getTotalBytes() : null
        this.progress()
      }).catch(() => {})
    }
    const done = (state: 'completed' | 'cancelled' | 'interrupted') => {
      if (finished) return
      finished = true
      cleanup()
      const task = (async () => {
        await accept()
        if (!record || !batch) return
        const active = this.active.get(record.id)
        if (active?.ownsHost && active.host) this.releaseHost(active.host)
        this.active.delete(record.id)
        record.canPause = false
        if (record.phase === 'cancelled') { await this.changed(); return }
        if (state === 'cancelled') { record.phase = 'cancelled'; record.reason = null }
        else if (state === 'interrupted') { record.phase = 'waiting'; record.reason = 'Browser download interrupted. Continue from its source'; record.canContinue = record.candidates.length > 0 }
        else {
          record.phase = 'verifying'; await this.changed()
          try {
            const path = batch.savedPath!
            const details = await lstat(path)
            if (!details.isFile() || details.isSymbolicLink() || details.size !== item.getReceivedBytes()) throw new Error('Downloaded file is incomplete')
            if (record.kind !== 'unknown') await verifyDownloaded(path, record.fileName, record.kind, item.getMimeType())
            record.receivedBytes = details.size; record.totalBytes = details.size; record.verified = true; record.published = true; record.phase = 'complete'
          } catch { record.phase = 'failed'; record.reason = 'Saved file could not be verified' }
        }
        await this.changed()
        this.schedule()
      })()
      this.track(task)
    }
    const onDone = (_event: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted') => done(state)
    const cleanup = () => {
      item.removeListener('updated', progress)
      item.removeListener('done', onDone)
      this.ordinaryCleanups.delete(cleanup)
    }
    this.ordinaryCleanups.add(cleanup)
    item.on('updated', progress)
    item.once('done', onDone)
    progress()
    const state = item.getState()
    if (state === 'completed' || state === 'cancelled' || state === 'interrupted') done(state)
  }

  pause(id: string): Promise<void> {
    return this.command(async () => {
      for (const file of this.findFiles(id)) {
        if (!['queued', 'resolving', 'attempting', 'downloading'].includes(file.phase)) continue
        file.phase = 'paused'; file.canPause = false
        const active = this.active.get(file.id)
        if (active?.control) {
          active.control.pause()
          if (active.ownsHost && active.host) { active.ownsHost = false; this.releaseHost(active.host) }
        }
        else active?.controller.abort()
      }
      await this.changed()
      this.schedule()
    })
  }
  resume(id: string): Promise<void> {
    return this.command(async () => {
      for (const file of this.findFiles(id)) {
        if (file.phase !== 'paused') continue
        const active = this.active.get(file.id)
        if (active?.control && !active.controller.signal.aborted) { file.phase = 'queued'; file.canPause = false }
        else { file.phase = 'queued'; file.reason = 'Restarting interrupted transfer' }
      }
      await this.changed(); this.schedule()
    })
  }
  retry(id: string): Promise<void> {
    return this.command(async () => {
      for (const file of this.findFiles(id)) {
        if (this.batches.find(batch => batch.id === file.batchId)?.origin === 'browser') throw new Error('Continue from the source to restart this browser download')
        if (!['failed', 'waiting'].includes(file.phase)) continue
        if (!file.candidates.length && !file.publishedName && !file.verified && !file.archiveDownloaded) throw new Error('Open the topic and select this source again')
        file.phase = file.published ? 'importing' : file.verified ? 'staged' : 'queued'
        file.candidateIndex = 0; file.reason = null; file.canContinue = false; file.browserOnly = false
        file.browserTriedSources = []
      }
      await this.changed(); this.schedule()
      for (const batch of this.batches) if (batch.id === id || batch.files.some(file => file.id === id)) void this.startFinishBatch(batch)
    })
  }
  unlock(id: string, password: string): Promise<void> {
    return this.command(async () => {
      if (typeof password !== 'string' || !password || password.length > 256) throw new Error('Invalid archive password')
      const files = this.findFiles(id).filter(file => file.archiveDownloaded && ['password-required', 'wrong-password'].includes(file.archive?.state ?? '') && !FINISHING.has(file.phase) && file.phase !== 'cancelled')
      if (!files.length) throw new Error('Archive is not waiting for a password')
      for (const file of files) {
        this.archivePasswords.set(file.id, password)
        file.phase = 'queued'; file.reason = null; file.canContinue = false
      }
      await this.changed(); this.schedule()
    })
  }
  selectArchive(id: string, entryIds: string[]): Promise<void> {
    return this.command(async () => {
      if (!Array.isArray(entryIds) || !entryIds.length || entryIds.length > 2048 || new Set(entryIds).size !== entryIds.length || entryIds.some(entry => typeof entry !== 'string' || !/^entry-\d{1,5}$/.test(entry))) throw new Error('Invalid archive selection')
      const files = this.findFiles(id).filter(file => file.archiveDownloaded && file.archive?.state === 'selection-required' && !file.verified && file.phase === 'waiting')
      if (files.length !== 1) throw new Error('Archive is not waiting for a selection')
      const file = files[0]!
      if (entryIds.some(entryId => !file.archive?.entries.some(entry => entry.id === entryId))) throw new Error('Invalid archive selection')
      for (const entry of file.archive!.entries) entry.selected = entryIds.includes(entry.id)
      file.phase = 'queued'; file.reason = null; file.canContinue = false
      await this.changed(); this.schedule()
    })
  }
  continue(id: string): Promise<void> {
    return this.command(async () => {
      for (const file of this.findFiles(id)) {
        if (file.archiveDownloaded) continue
        if (file.phase !== 'waiting' || !file.canContinue || !file.candidates.length) continue
        if (this.batches.find(batch => batch.id === file.batchId)?.origin === 'browser') {
          if (!this.options.openOrdinarySource) throw new Error('Browser download source is unavailable')
          const url = file.candidates[0]!.url
          this.ordinaryResumptions.set(file.id, { url, expiresAt: Date.now() + 15 * 60_000 })
          try { await this.options.openOrdinarySource(url) }
          catch (error) { this.ordinaryResumptions.delete(file.id); throw error }
          continue
        }
        const attempt = [...file.attempts].reverse().find(entry => entry.sourceId === file.sourceId && entry.outcome === 'waiting')
        if (attempt) await this.options.continueAttempt?.(file.id, attempt.id ?? `${file.id}:${file.attempts.length}`)
        file.candidateIndex = Math.min(file.candidateIndex, file.candidates.length - 1)
        const candidate = file.candidates[file.candidateIndex]!
        if (browserFallback(candidate) && !file.browserTriedSources.includes(candidate.id)) {
          file.browserOnly = true; file.browserTriedSources.push(candidate.id)
        }
        file.phase = 'queued'; file.reason = null; file.canContinue = false
      }
      await this.changed(); this.schedule()
    })
  }
  cancel(id: string): Promise<void> {
    return this.command(async () => {
      await this.cancelFiles(this.findFiles(id)); await this.changed(); this.schedule()
    })
  }
  videoOnly(id: string): Promise<void> {
    return this.command(async () => {
      const batch = this.batches.find(candidate => candidate.id === id)
      if (!batch || batch.origin === 'browser' || this.committing.has(id) || !batch.files.some(file => file.kind === 'video' && file.verified && file.phase === 'staged')) throw new Error('No verified video is ready to import')
      await this.cancelFiles(batch.files.filter(file => file.kind !== 'video'))
      await this.changed()
      void this.startFinishBatch(batch)
    })
  }
  cancelAll(): Promise<void> {
    return this.command(async () => { await this.cancelFiles(this.batches.filter(batch => batch.files.some(file => !TERMINAL.has(file.phase))).flatMap(batch => batch.files)); await this.changed(); this.schedule() })
  }
  clear(): Promise<void> {
    return this.command(async () => {
      for (const batch of this.batches) if (batch.files.every(file => TERMINAL.has(file.phase))) for (const file of batch.files) file.dismissed = true
      await this.changed()
    })
  }
  async destroy(): Promise<void> {
    if (this.closed) { await this.journal.flush(); return }
    this.closed = true
    if (this.emission) clearTimeout(this.emission)
    for (const cleanup of [...this.ordinaryCleanups]) cleanup()
    this.ordinaryResumptions.clear()
    this.archivePasswords.clear()
    for (const active of this.active.values()) { active.controller.abort(); active.control?.cancel() }
    await this.commandTail
    await Promise.allSettled([...this.work])
    await this.persist()
    await this.journal.flush()
  }

  private command<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(() => { if (this.closed) throw new Error('Download queue closed'); return fn() })
    this.commandTail = result.catch(() => {})
    return result
  }
  private findFiles(id: string): FileRecord[] { return this.batches.flatMap(batch => batch.id === id ? batch.files : batch.files.filter(file => file.id === id)) }
  private async persist(): Promise<void> {
    const saved: StoredQueue = { version: 1, batches: this.batches.map(({ sourceTopicUrl, ...batch }) => ({ ...batch, sealedTopicUrl: this.codec.seal(sourceTopicUrl), files: batch.files.map(({ candidates, ...file }) => ({ ...file, sealedCandidates: candidates.length ? this.codec.seal(JSON.stringify(candidates)) : null })) })) }
    await this.journal.save(saved)
  }
  private emit(): void { this.options.onState(this.state()) }
  private async changed(): Promise<void> { await this.persist(); this.emit() }
  private progress(): void {
    if (this.emission || this.closed) return
    this.emission = setTimeout(() => { this.emission = null; void this.changed().catch(() => {}) }, 250)
    this.emission.unref?.()
  }
  private schedule(): void {
    if (this.closed) return
    let count = this.runningCount()
    for (const [id, active] of this.active) {
      if (count >= 2) break
      const file = this.findFiles(id)[0]
      if (!file || file.phase !== 'queued' || !active.control || active.controller.signal.aborted) continue
      if (active.host && !active.ownsHost) {
        if (this.hosts.has(active.host)) continue
        this.hosts.add(active.host); active.ownsHost = true
      }
      file.phase = 'downloading'; file.canPause = true; active.control.resume(); count++
      this.progress()
    }
    for (const batch of this.batches) {
      for (const file of batch.files) {
        if (count >= 2) return
        if (file.phase !== 'queued' || this.active.has(file.id)) continue
        const candidate = file.archiveDownloaded ? undefined : file.candidates[file.candidateIndex]
        if (candidate && this.hosts.has(new URL(candidate.url).hostname)) continue
        const transferHost = candidate ? new URL(candidate.url).hostname : undefined
        const active: ActiveTransfer = { controller: new AbortController(), attemptId: '', control: null, host: transferHost, ownsHost: transferHost !== undefined }
        if (transferHost) this.hosts.add(transferHost)
        this.active.set(file.id, active)
        count++
        const task = this.runFile(batch, file, active).catch(async () => {
          if (!this.closed && !['paused', 'cancelled'].includes(file.phase)) { file.phase = 'failed'; file.reason = 'Download could not be saved'; await this.changed() }
        }).finally(() => {
          if (active.ownsHost && active.host) { active.ownsHost = false; this.releaseHost(active.host) }
          this.active.delete(file.id); this.schedule()
        })
        this.track(task)
      }
    }
  }
  private runningCount(): number {
    return [...this.active].filter(([id, active]) => {
      const phase = this.findFiles(id)[0]?.phase
      return phase !== 'paused' && !(phase === 'queued' && active.control !== null)
    }).length
  }
  private async takeHost(host: string, signal: AbortSignal): Promise<void> {
    while (this.hosts.has(host)) {
      if (signal.aborted) throw new Error('Interrupted')
      await new Promise<void>(resolve => {
        const wake = () => { this.hostWaiters.delete(wake); signal.removeEventListener('abort', wake); resolve() }
        this.hostWaiters.add(wake); signal.addEventListener('abort', wake, { once: true })
      })
    }
    if (signal.aborted) throw new Error('Interrupted')
    this.hosts.add(host)
  }
  private releaseHost(host: string): void { this.hosts.delete(host); for (const wake of [...this.hostWaiters]) wake() }

  private async runFile(batch: BatchRecord, file: FileRecord, active: ActiveTransfer): Promise<void> {
    const signal = active.controller.signal
    if (file.archiveDownloaded) { await this.prepareArchive(batch, file, active); await this.startFinishBatch(batch); return }
    while (file.candidateIndex < file.candidates.length) {
      if (signal.aborted || this.closed) return
      const source = file.candidates[file.candidateIndex]!
      active.control = null; file.canPause = false
      const checked = await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
      batch.stageDirectory = await stagingDirectory(checked, batch.id)
      const stagePath = join(batch.stageDirectory, file.stageName)
      if (!/^[a-f0-9-]{36}$/i.test(file.stageName)) throw new Error('Invalid staging identity')
      await rm(stagePath, { force: true })
      file.phase = 'resolving'; file.host = source.host; file.sourceId = source.id; file.receivedBytes = 0; file.totalBytes = null; file.canContinue = false
      file.attempts.push({ id: `${file.id}:${file.attempts.length + 1}`, host: source.host, sourceId: source.id, at: Date.now(), outcome: 'starting', reason: null, tabId: null })
      const attempt = file.attempts.at(-1)!
      active.attemptId = `${file.id}:${file.attempts.length}`
      await this.changed()
      let directUrl: string | null
      try { directUrl = file.browserOnly ? null : this.options.resolveSource ? await this.options.resolveSource(source) : findDirect(source) }
      catch { directUrl = null }
      if (directUrl) safeSource({ ...source, url: directUrl })
      const transferHost = new URL(source.url).hostname
      if (!active.ownsHost || active.host !== transferHost) await this.takeHost(transferHost, signal)
      if (signal.aborted || this.closed) { active.ownsHost = false; this.releaseHost(transferHost); return }
      active.host = transferHost; active.ownsHost = true
      file.phase = directUrl ? 'resolving' : 'attempting'
      await this.changed()
      const attemptId = active.attemptId
      const request: TransferRequest = {
        attemptId: active.attemptId, fileId: file.id, batchId: batch.id, topic: { tabId: batch.topicTabId, generation: batch.topicGeneration, url: batch.sourceTopicUrl }, candidate: source, directUrl, stagingPath: stagePath, signal,
        onProgress: progress => {
          if (signal.aborted || this.closed || this.active.get(file.id) !== active || active.attemptId !== attemptId || !['resolving', 'attempting', 'downloading'].includes(file.phase)) return
          if (!Number.isSafeInteger(progress.receivedBytes) || progress.receivedBytes < 0 || (progress.totalBytes !== null && (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 0))) return
          file.receivedBytes = progress.receivedBytes; file.totalBytes = progress.totalBytes && progress.totalBytes >= progress.receivedBytes ? progress.totalBytes : null; file.canPause = progress.canPause ?? active.control !== null; file.phase = 'downloading'; this.progress()
        },
        onControl: control => { if (!signal.aborted && this.active.get(file.id) === active && active.attemptId === attemptId && ['resolving', 'attempting', 'downloading'].includes(file.phase)) { active.control = control; file.canPause = true } },
      }
      let result
      try { result = await this.options.transport(request) }
      catch { result = { status: 'failed' as const, reason: 'Host connection failed', scope: 'remote' as const } }
      finally { active.control = null; if (active.ownsHost && active.host === transferHost) { active.ownsHost = false; this.releaseHost(transferHost) } }
      if (signal.aborted || this.closed || this.interrupted(file)) return
      file.canPause = false
      if (result.status === 'complete') {
        file.phase = 'verifying'; await this.changed()
        try {
          file.originalName = fullFileName(result.fileName)
          file.fileName = safeFileName(file.originalName)
          if (source.fileName && safeFileName(source.fileName).toLowerCase() !== file.fileName.toLowerCase()) throw new VerificationError('The source returned a different file')
          const size = (await stat(stagePath)).size
          if (result.totalBytes > 0 && result.totalBytes !== size) throw new VerificationError('Incomplete download')
          if (await zipDownload(stagePath, file.fileName, result.mimeType)) {
            if (file.kind === 'video') throw new VerificationError('The source returned a different file')
            if (!/\.zip$/i.test(file.fileName)) file.fileName = safeFileName(`${file.fileName}.zip`)
            file.kind = 'archive'; file.archiveDownloaded = true; file.receivedBytes = size; file.totalBytes = size; attempt.outcome = 'complete'
            await this.changed()
            await this.prepareArchive(batch, file, active)
            await this.startFinishBatch(batch)
            return
          }
          file.kind = await verifyDownloaded(stagePath, file.fileName, file.kind, result.mimeType)
          if (signal.aborted || this.closed || this.interrupted(file)) return
          if (result.totalBytes > 0 && result.totalBytes !== size) throw new VerificationError('Incomplete download')
          file.receivedBytes = size; file.totalBytes = size; file.verified = true; file.phase = 'staged'; attempt.outcome = 'complete'
          await this.changed(); await this.startFinishBatch(batch); return
        } catch (error) {
          if (signal.aborted || this.closed || this.interrupted(file)) return
          if (!(error instanceof VerificationError)) { file.phase = 'failed'; file.reason = 'Downloaded file could not be verified'; await this.changed(); return }
          attempt.outcome = 'failed'; attempt.reason = error.message
          if (error.unsupported) { file.phase = 'failed'; file.reason = error.message; await this.changed(); return }
          result = { status: 'failed', reason: error.message, scope: 'remote' }
        }
      }
      if (result.status === 'waiting') { attempt.outcome = 'waiting'; attempt.reason = result.reason; attempt.tabId = result.tabId ?? null }
      else if (result.status === 'failed') {
        attempt.outcome = 'failed'; attempt.reason = result.reason
        if (result.scope === 'local') { file.phase = 'failed'; file.reason = result.reason; await this.changed(); return }
      }
      const next = file.candidateIndex + 1
      if (!file.browserOnly && next < file.candidates.length) { file.candidateIndex = next; file.reason = `Trying ${file.candidates[next]!.host}`; await this.changed(); continue }
      const waiting = [...file.attempts].reverse().find(entry => entry.outcome === 'waiting')
      if (waiting) {
        file.candidateIndex = Math.max(0, file.candidates.findIndex(candidate => candidate.id === waiting.sourceId))
        file.phase = 'waiting'; file.reason = waiting.reason; file.canContinue = true
        file.sourceId = waiting.sourceId; file.host = waiting.host
      } else {
        const fallbackIndex = file.browserOnly ? -1 : file.candidates.findIndex(candidate => browserFallback(candidate) && !file.browserTriedSources.includes(candidate.id))
        if (fallbackIndex >= 0) {
          const fallback = file.candidates[fallbackIndex]!
          file.candidateIndex = fallbackIndex; file.sourceId = fallback.id; file.host = fallback.host
          if (/^(?:www\.)?pixeldrain\.com$/.test(new URL(fallback.url).hostname)) {
            file.browserOnly = true; file.browserTriedSources.push(fallback.id)
            file.reason = `Trying ${fallback.host}`
            await this.changed()
            continue
          }
          file.phase = 'waiting'; file.reason = 'Continue on the source page to check this download'; file.canContinue = true
        } else { file.phase = 'failed'; file.reason = result.status === 'failed' ? result.reason : 'Could not start this download' }
      }
      await this.changed(); return
    }
    file.phase = 'waiting'; file.reason = 'Open the topic and select this source again'; await this.changed()
  }

  private syncArchive(file: FileRecord): void {
    if (!file.archive) return
    for (const entry of file.archive.entries) {
      const artifact = file.archiveArtifacts?.find(value => value.entryId === entry.id)
      entry.publishedName = artifact?.publishedName ?? undefined
    }
  }

  private async prepareArchive(batch: BatchRecord, file: FileRecord, active: ActiveTransfer): Promise<void> {
    const signal = active.controller.signal
    let extractedDirectory: string | undefined
    const createdStages: string[] = []
    let encrypted = false
    try {
      await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
      await stagingDirectory(batch.checked, batch.id)
      const stagePath = join(batch.stageDirectory, file.stageName)
      const inspection = await inspectArchive(stagePath, { signal })
      encrypted = inspection.encrypted
      if (inspection.entries.some(entry => !safeEntryName(entry.name))) throw new ArchiveError('limit', 'Archive path limit')
      const previousSelection = file.archive?.entries.filter(entry => entry.selected).map(entry => entry.id)
      const selected = previousSelection?.length ? previousSelection : inspection.defaultEntryIds
      file.archive = { state: 'extracting', entries: inspection.entries.map(entry => ({ id: entry.id, name: entry.name, kind: entry.kind, bytes: entry.bytes, selected: selected.includes(entry.id) })), extractedBytes: 0, totalBytes: inspection.entries.filter(entry => selected.includes(entry.id)).reduce((total, entry) => total + entry.bytes, 0), skippedEntries: inspection.skippedEntries }
      file.canPause = false; file.canContinue = false
      if (inspection.requiresSelection && !selected.length) {
        file.archive.state = 'selection-required'; file.phase = 'waiting'; file.reason = 'Choose files from this archive'
        await this.changed(); return
      }
      file.phase = 'extracting'; file.reason = null
      await this.changed()
      const source = file.candidates[file.candidateIndex]
      const manualPassword = this.archivePasswords.get(file.id)
      const passwords = [...new Set([...(manualPassword ? [manualPassword] : []), ...(source?.archivePasswords ?? [])])].slice(0, MAX_CANDIDATES)
      const extracted = await extractArchive(stagePath, { signal, entryIds: [...selected], passwords, onProgress: (_entry, bytes, total) => {
        if (signal.aborted || this.closed || file.phase !== 'extracting' || !file.archive) return
        file.archive.extractedBytes = bytes; file.archive.totalBytes = total; this.progress()
      } })
      extractedDirectory = extracted.directory
      const artifacts: ArchiveArtifact[] = []
      for (const entry of extracted.files) {
        if (signal.aborted || this.closed || this.interrupted(file)) throw new ArchiveError('cancelled', 'Archive extraction cancelled')
        await verifyDownloaded(entry.path, entry.fileName, entry.kind)
        await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
        await stagingDirectory(batch.checked, batch.id)
        const stageName = randomUUID()
        await link(entry.path, join(batch.stageDirectory, stageName))
        createdStages.push(stageName)
        artifacts.push({ id: randomUUID(), archiveParentId: file.id, entryId: entry.id, entryName: entry.name, fileName: safeFileName(entry.fileName), kind: entry.kind, stageName, publishedName: null, published: false })
      }
      if (signal.aborted || this.closed || this.interrupted(file)) throw new ArchiveError('cancelled', 'Archive extraction cancelled')
      file.archiveArtifacts = artifacts; file.verified = true; file.published = false
      file.archive.state = 'ready'; file.archive.extractedBytes = file.archive.totalBytes
      file.phase = 'staged'; file.reason = null
      await this.changed()
    } catch (error) {
      for (const stageName of createdStages) await unlink(join(batch.stageDirectory, stageName)).catch(() => {})
      if (signal.aborted || this.closed || this.interrupted(file)) return
      file.verified = false; file.canContinue = false
      if (error instanceof ArchiveError && error.code === 'corrupt' && encrypted && file.archive) {
        file.archive.state = 'password-required'; file.phase = 'waiting'; file.reason = 'Archive verification failed'
      } else if (error instanceof ArchiveError && ['password-required', 'wrong-password', 'selection-required'].includes(error.code)) {
        if (file.archive) file.archive.state = error.code === 'selection-required' ? 'selection-required' : error.code === 'password-required' ? 'password-required' : 'wrong-password'
        file.phase = 'waiting'; file.reason = error.message
      } else {
        file.phase = 'failed'; file.reason = error instanceof ArchiveError || error instanceof VerificationError ? error.message : 'Archive could not be extracted'
      }
      await this.changed()
    } finally {
      if (extractedDirectory) await rm(extractedDirectory, { recursive: true, force: true })
    }
  }

  private track(task: Promise<void>): void {
    this.work.add(task)
    void task.then(() => this.work.delete(task), () => this.work.delete(task))
  }
  private startFinishBatch(batch: BatchRecord): Promise<void> {
    const task = this.finishBatch(batch)
    this.track(task)
    return task
  }
  private async finishBatch(batch: BatchRecord): Promise<void> {
    if (batch.origin === 'browser' || this.committing.has(batch.id) || this.closed) return
    const required = batch.files.filter(file => file.phase !== 'cancelled')
    if (!required.length || !required.every(file => file.verified || file.phase === 'complete') || required.every(file => file.phase === 'complete')) return
    this.committing.add(batch.id)
    const pending = required.filter(file => file.phase !== 'complete')
    for (const file of pending) file.phase = file.published ? 'importing' : 'publishing'
    try {
      await this.changed()
      await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
      await stagingDirectory(batch.checked, batch.id)
      const publications = publicationFiles(required)
      const pendingPublications = publicationFiles(pending)
      if (pendingPublications.some(file => !file.published)) {
        await this.reserveNames(batch, publications)
        for (const file of pending) { file.phase = 'publishing'; this.syncArchive(file) }
        await this.changed()
        const ordered = [...pendingPublications].sort((a, b) => Number(a.kind === 'video') - Number(b.kind === 'video'))
        for (const file of ordered) {
          await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
          await stagingDirectory(batch.checked, batch.id)
          if (!/^[a-f0-9-]{36}$/i.test(file.stageName) || !file.publishedName) throw new Error('Invalid staged file')
          const target = join(batch.checked.directory, file.publishedName)
          const source = join(batch.stageDirectory, file.stageName)
          const details = await lstat(source)
          if (!details.isFile() || details.isSymbolicLink()) throw new Error('Unsafe staged file')
          if (file.archiveParentId) await verifyDownloaded(source, file.fileName, file.kind)
          try { await link(source, target) }
          catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
            const [left, right] = await Promise.all([lstat(source), lstat(target)])
            if (left.ino !== right.ino || left.dev !== right.dev || right.isSymbolicLink()) throw new Error('A destination file already exists')
          }
          file.published = true
          for (const parent of pending) if (parent.archiveArtifacts?.length) parent.published = parent.archiveArtifacts.every(entry => entry.published)
          await this.persist()
        }
      }
      for (const file of pending) { file.phase = 'importing'; file.reason = null; this.syncArchive(file) }
      await this.changed()
      const imported = await this.options.importPublished({ id: batch.id, destination: { ...batch.destination }, paths: publications.map(file => join(batch.checked.directory, file.publishedName!)), files: publications.map(file => ({ id: file.id, kind: file.kind, name: file.publishedName! })) })
      for (const file of pending) { file.phase = 'complete'; file.mediaId = imported.mediaId; file.canContinue = false; this.archivePasswords.delete(file.id) }
      await this.changed()
      await this.cleanupImported(batch, pending)
    } catch {
      for (const file of batch.files) if (FINISHING.has(file.phase) || file.phase === 'staged') { file.phase = 'failed'; file.reason = file.published ? 'Library import failed; retry import' : 'Could not publish to the chosen folder' }
      await this.changed()
    } finally { this.committing.delete(batch.id) }
  }

  private async cleanupImported(batch: BatchRecord, files: FileRecord[]): Promise<void> {
    let cleanupFailed = false
    try {
      const stage = await lstat(batch.stageDirectory).catch(() => null)
      if (!stage) return
      await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
      await stagingDirectory(batch.checked, batch.id)
      for (const file of files) {
        if (file.phase !== 'complete') continue
        try {
          if (/^[a-f0-9-]{36}$/i.test(file.stageName)) await unlink(join(batch.stageDirectory, file.stageName)).catch(error => { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error })
          for (const entry of file.archiveArtifacts ?? []) if (/^[a-f0-9-]{36}$/i.test(entry.stageName)) await unlink(join(batch.stageDirectory, entry.stageName)).catch(error => { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error })
          if (file.archiveArtifacts?.length) file.archiveDownloaded = false
        } catch { if (file.archiveArtifacts?.length) { file.reason = 'Archive cleanup failed'; cleanupFailed = true } }
      }
      await rmdir(batch.stageDirectory).catch(() => {})
      await this.persist()
      if (cleanupFailed) this.emit()
    } catch {
      for (const file of files) if (file.phase === 'complete' && file.archiveArtifacts?.length) { file.reason = 'Archive cleanup failed'; cleanupFailed = true }
      if (cleanupFailed) { await this.persist(); this.emit() }
    }
  }

  private async reserveNames(batch: BatchRecord, files: PublicationFile[]): Promise<void> {
    if (files.every(file => file.publishedName)) return
    if (files.some(file => file.archiveParentId)) { await this.reserveArchiveNames(batch, files); return }
    const video = files.find(file => file.kind === 'video')
    const stem = video ? basename(video.originalName ?? video.fileName, extname(video.originalName ?? video.fileName)) : null
    const names = files.map(file => {
      if (!stem || file.kind === 'video') return file.originalName ?? file.fileName
      if (file.kind === 'archive') return `${stem}.zip`
      const originalName = file.originalName ?? file.fileName
      const originalBase = basename(originalName, extname(originalName))
      const parsedStem = originalScriptStem(originalName, new Set([stem.toLowerCase()]))
      const suffix = originalBase.slice(parsedStem.length)
      return `${stem}${suffix}.funscript`
    })
    const existing = new Set((await readdir(batch.checked.directory)).map(name => name.toLowerCase()))
    const maximumSuffix = stem ? Math.max(...names.filter(name => name.startsWith(stem)).map(name => Buffer.byteLength(name.slice(stem.length)))) : 0
    for (let number = 0; number < 10_000; number++) {
      const suffix = number ? ` (${number + 1})` : ''
      const proposed = names.map(name => {
        if (stem && name.startsWith(stem)) return safeFileName(`${truncateFileStem(stem, 220 - maximumSuffix - Buffer.byteLength(suffix))}${suffix}${name.slice(stem.length)}`)
        const ext = extname(name)
        return safeFileName(`${basename(name, ext)}${suffix}${ext}`)
      })
      if (new Set(proposed.map(name => name.toLowerCase())).size !== proposed.length) throw new Error('Selected scripts have conflicting names')
      if (proposed.some(name => existing.has(name.toLowerCase()))) continue
      files.forEach((file, index) => { file.publishedName = proposed[index]! })
      await this.persist(); return
    }
    throw new Error('Could not reserve unused file names')
  }
  private async reserveArchiveNames(batch: BatchRecord, files: PublicationFile[]): Promise<void> {
    const groups = new Map<string, { stem: string; files: { file: PublicationFile; suffix: string }[] }>()
    const videos = files.filter(file => file.kind === 'video')
    const normalVideo = videos.find(file => !file.archiveParentId)
    const ordered = [...files].sort((a, b) => Number(a.kind === 'script') - Number(b.kind === 'script') || (a.entryName?.split('/').length ?? 1) - (b.entryName?.split('/').length ?? 1))
    for (const file of ordered) {
      const originalName = fullFileName(file.entryName ?? file.originalName ?? file.fileName)
      const originalStem = basename(originalName, extname(originalName))
      let stem = originalStem
      let suffix = extname(originalName)
      let group = `normal:${file.id}`
      if (file.archiveParentId) {
        const ownVideos = videos.filter(video => video.archiveParentId === file.archiveParentId)
        const knownNames = videos.filter(video => video.archiveParentId === file.archiveParentId || !video.archiveParentId).map(video => fullFileName(video.entryName ?? video.originalName ?? video.fileName))
        const foldedStems = new Set(knownNames.map(name => basename(name, extname(name)).toLowerCase()))
        const base = file.kind === 'script' ? originalScriptStem(originalName, foldedStems) : originalStem
        const videoStem = (candidate: PublicationFile) => { const name = fullFileName(candidate.entryName ?? candidate.originalName ?? candidate.fileName); return basename(name, extname(name)) }
        const matches = ownVideos.filter(video => videoStem(video).toLowerCase() === base.toLowerCase())
        const sameFolder = matches.filter(video => dirname(video.entryName ?? '') === dirname(file.entryName ?? ''))
        let video = file.kind === 'video' ? file : sameFolder.length === 1 ? sameFolder[0] : matches.length === 1 ? matches[0] : undefined
        if (!video && !matches.length && file.kind === 'script') {
          const external = videos.filter(candidate => !candidate.archiveParentId && videoStem(candidate).toLowerCase() === base.toLowerCase())
          if (external.length === 1) video = external[0]
        }
        if (video) {
          stem = videoStem(video)
          suffix = file.kind === 'video' ? extname(originalName) : `${originalStem.slice(base.length)}${extname(originalName)}`
          group = `video:${video.id}`
        } else {
          stem = base
          suffix = `${originalStem.slice(stem.length)}${extname(originalName)}`
          group = `archive:${file.archiveParentId}:${dirname(file.entryName ?? '')}:${stem.toLowerCase()}`
        }
      } else if (normalVideo) {
        if (file.kind === 'video') group = `video:${file.id}`
        else {
          const normalName = normalVideo.originalName ?? normalVideo.fileName
          stem = basename(normalName, extname(normalName))
          const base = originalScriptStem(originalName, new Set([stem.toLowerCase()]))
          suffix = `${originalStem.slice(base.length)}${extname(originalName)}`
          group = `video:${normalVideo.id}`
        }
      }
      const existing = groups.get(group)
      if (existing) {
        if (existing.files.some(item => item.suffix.toLowerCase() === suffix.toLowerCase())) {
          const label = safeFileName(basename(dirname(file.entryName ?? '')) === '.' ? 'variant' : basename(dirname(file.entryName ?? '')))
          let number = 0
          let proposed: string
          do { proposed = `.${label}${number ? ` (${number + 1})` : ''}${suffix}`; number++ } while (existing.files.some(item => item.suffix.toLowerCase() === proposed.toLowerCase()))
          suffix = proposed
        }
        existing.files.push({ file, suffix })
      } else groups.set(group, { stem, files: [{ file, suffix }] })
    }
    const occupied = new Set((await readdir(batch.checked.directory)).map(name => name.normalize('NFC').toLowerCase()))
    for (const group of groups.values()) {
      const maximumSuffix = Math.max(...group.files.map(item => Buffer.byteLength(item.suffix)))
      if (maximumSuffix > 200) throw new Error('Archive file name is too long')
      let reserved = false
      for (let number = 0; number < 10_000; number++) {
        const collision = number ? ` (${number + 1})` : ''
        const stem = truncateFileStem(group.stem, 220 - maximumSuffix - Buffer.byteLength(collision))
        const names = group.files.map(item => safeFileName(`${stem}${collision}${item.suffix}`))
        const keys = names.map(name => name.normalize('NFC').toLowerCase())
        if (new Set(keys).size !== keys.length || keys.some(key => occupied.has(key))) continue
        group.files.forEach((item, index) => { item.file.publishedName = names[index]!; occupied.add(keys[index]!) })
        reserved = true; break
      }
      if (!reserved) throw new Error('Could not reserve unused archive names')
    }
    await this.persist()
  }
  private async cancelFiles(files: FileRecord[]): Promise<void> {
    for (const file of files) {
      this.ordinaryResumptions.delete(file.id)
      if (file.phase === 'complete' || file.phase === 'cancelled' || FINISHING.has(file.phase)) continue
      const completedTransfer = file.phase === 'verifying'
      const active = this.active.get(file.id)
      active?.controller.abort(); active?.control?.cancel()
      if (active?.ordinary) { if (active.ownsHost && active.host) { active.ownsHost = false; this.releaseHost(active.host) }; this.active.delete(file.id) }
      file.phase = 'cancelled'; file.canPause = false; file.canContinue = false; file.reason = null
      const batch = this.batches.find(candidate => candidate.id === file.batchId)!
      if (batch.origin === 'browser' || file.archiveDownloaded) continue
      try {
        await checkDestination(await this.options.getRoot(batch.destination.rootId), batch.destination, batch.checked)
        await stagingDirectory(batch.checked, batch.id)
        if (completedTransfer && /^[a-f0-9-]{36}$/i.test(file.stageName) && await zipDownload(join(batch.stageDirectory, file.stageName), file.fileName)) { file.archiveDownloaded = true; file.kind = 'archive'; continue }
        if (/^[a-f0-9-]{36}$/i.test(file.stageName)) await unlink(join(batch.stageDirectory, file.stageName)).catch(() => {})
      } catch { }
    }
  }
  private interrupted(file: FileRecord): boolean { return file.phase === 'cancelled' || file.phase === 'paused' }
}

function candidatesPresent(file: FileRecord): boolean { return file.candidates.length > 0 }

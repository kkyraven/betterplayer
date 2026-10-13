import { isEroTopicUrl, type EroSource, type EroTopic } from '@shared/eroscripts'
import type { DownloadBatch, DownloadFile } from '@shared/downloads'

function topicId(url: string): string | null {
  if (!isEroTopicUrl(url)) return null
  const segments = new URL(url).pathname.split('/')
  return /^\d+$/.test(segments[2] ?? '') ? segments[2]! : segments[3] ?? null
}

export function topicSourceJob(topic: Pick<EroTopic, 'tabId' | 'url'>, source: Pick<EroSource, 'id'>, batches: readonly DownloadBatch[]): { file: DownloadFile; destinationName: string } | undefined {
  return topicSourcesJob(topic, [source], batches)
}

export function topicSourcesJob(topic: Pick<EroTopic, 'tabId' | 'url'>, sources: readonly Pick<EroSource, 'id'>[], batches: readonly DownloadBatch[]): { file: DownloadFile; destinationName: string } | undefined {
  const id = topicId(topic.url)
  if (!id) return undefined
  const sourceIds = new Set(sources.map((source) => source.id))
  for (const batch of [...batches].sort((a, b) => b.createdAt - a.createdAt)) {
    if (batch.origin === 'browser' || batch.topicTabId !== topic.tabId || topicId(batch.topicUrl) !== id) continue
    const file = batch.files.find((file) => sourceIds.has(file.sourceId) || file.attempts.some((attempt) => sourceIds.has(attempt.sourceId)))
    if (file) return { file, destinationName: batch.destinationName }
  }
  return undefined
}

export function distinctTopicFiles(sources: EroSource[]): EroSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = source.mirrorKey ? `${source.kind}:${source.mirrorKey}` : source.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function topicFileSources(file: EroSource, sources: EroSource[]): EroSource[] {
  return sources.filter((source) => source.id === file.id || !!file.mirrorKey && source.kind === file.kind && source.mirrorKey === file.mirrorKey)
}

export function initialTopicSelection(sources: EroSource[]): string[] {
  const files = distinctTopicFiles(sources)
  const videos = files.filter((source) => source.kind === 'video')
  const scripts = files.filter((source) => source.kind === 'script')
  if (videos.length > 1 || scripts.length > 1) return []
  if (videos.length === 1 && scripts.length === 1) {
    const video = videos[0]!
    const script = scripts[0]!
    const stem = (name: string | null) => name?.replace(/\.(?:mp4|mkv|webm|mov|m4v|avi|wmv|mpeg|mpg|funscript)$/i, '').toLowerCase()
    if (stem(video.fileName) && stem(video.fileName) === stem(script.fileName)) return [video.id, script.id]
    return []
  }
  return [...videos, ...scripts].map((source) => source.id)
}

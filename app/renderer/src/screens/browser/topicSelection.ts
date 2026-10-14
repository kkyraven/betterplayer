import { isEroTopicUrl, type EroSource, type EroTopic } from '@shared/eroscripts'
import type { DownloadBatch, DownloadFile } from '@shared/downloads'
import type { AxisId } from '@shared/axes'
import { parseScriptName } from '@shared/matcher'

const VIDEO_EXTENSION = /\.(?:mp4|mkv|webm|mov|m4v|avi|wmv|mpeg|mpg)$/i

function topicId(url: string): string | null {
  if (!isEroTopicUrl(url)) return null
  const segments = new URL(url).pathname.split('/')
  return /^\d+$/.test(segments[2] ?? '') ? segments[2]! : segments[3] ?? null
}

export function topicSourceJob(topic: Pick<EroTopic, 'url'>, source: Pick<EroSource, 'id'>, batches: readonly DownloadBatch[]): { file: DownloadFile; destinationName: string } | undefined {
  return topicSourcesJob(topic, [source], batches)
}

export function topicSourcesJob(topic: Pick<EroTopic, 'url'>, sources: readonly Pick<EroSource, 'id'>[], batches: readonly DownloadBatch[]): { file: DownloadFile; destinationName: string } | undefined {
  const id = topicId(topic.url)
  if (!id) return undefined
  const sourceIds = new Set(sources.map((source) => source.id))
  for (const batch of [...batches].sort((a, b) => b.createdAt - a.createdAt)) {
    if (batch.origin === 'browser' || topicId(batch.topicUrl) !== id) continue
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
  const sets = scriptSets(files.filter((source) => source.kind === 'script'), videos)
  if (videos.length > 1 || sets.length > 1) return []
  const scripts = sets[0]?.scripts.map((script) => script.source.id) ?? []
  const video = videos[0]
  if (video && sets[0]) return video.fileName?.replace(VIDEO_EXTENSION, '').toLowerCase() === sets[0].key ? [video.id, ...scripts] : []
  return video ? [video.id] : scripts
}

export interface ScriptSet {
  key: string
  name: string
  scripts: Array<{ source: EroSource; axis: AxisId; variant: string | null }>
}

export function scriptSets(scripts: readonly EroSource[], videos: readonly EroSource[] = []): ScriptSet[] {
  const stems = new Set(videos.flatMap((video) => video.fileName ? [video.fileName.replace(VIDEO_EXTENSION, '')] : []))
  const sets = new Map<string, ScriptSet & { suffixes: string[] }>()
  for (const source of scripts) {
    const parsed = parseScriptName(source.fileName ?? source.label, stems)
    const key = parsed ? parsed.stem.toLowerCase() : `source:${source.id}`
    const set = sets.get(key) ?? { key, name: parsed?.stem ?? source.label, scripts: [], suffixes: [] }
    set.scripts.push({ source, axis: parsed?.axis ?? 'L0', variant: null })
    set.suffixes.push(parsed?.suffix ?? '')
    sets.set(key, set)
  }
  return [...sets.values()].map(({ suffixes, ...set }) => {
    const scripts = set.scripts.map((script, index) => {
      const repeated = set.scripts.filter((other) => other.axis === script.axis).length > 1
      return { ...script, variant: repeated ? suffixes[index] || null : null }
    })
    const stroke = scripts.filter((script) => script.axis === 'L0')
    return { ...set, scripts: [...stroke, ...scripts.filter((script) => script.axis !== 'L0')] }
  })
}

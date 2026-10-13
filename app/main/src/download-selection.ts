import type { DownloadDestination } from '@shared/downloads'
import type { EroTopic } from '@shared/eroscripts'
import type { TrustedDownloadSelection } from './downloads/transport'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function downloadDestination(value: unknown): DownloadDestination {
  if (!object(value) || typeof value.rootId !== 'number' || !Number.isSafeInteger(value.rootId) || value.rootId < 1 ||
      typeof value.relativePath !== 'string' || value.relativePath.length > 1024 ||
      /[\\\u0000:]/.test(value.relativePath) || value.relativePath.startsWith('/') ||
      value.relativePath.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Choose a library folder')
  }
  return { rootId: value.rootId, relativePath: value.relativePath }
}

export function downloadSelection(value: unknown, topic: EroTopic | null): TrustedDownloadSelection {
  if (!object(value) || !topic || value.tabId !== topic.tabId || value.generation !== topic.generation ||
      !Array.isArray(value.sourceIds) || value.sourceIds.length < 1 || value.sourceIds.length > 100 ||
      value.sourceIds.some((id) => typeof id !== 'string' || id.length > 256) ||
      (value.again !== undefined && typeof value.again !== 'boolean')) {
    throw new Error('Refresh the topic and select files')
  }
  const ids = new Set(value.sourceIds)
  const sources = topic.sources.filter((source) => ids.has(source.id)).map((source) => ({ ...source, ...(source.archivePasswords ? { archivePasswords: [...source.archivePasswords] } : {}) }))
  if (sources.length !== ids.size) throw new Error('The selected source is no longer available')
  return {
    topic: { tabId: topic.tabId, generation: topic.generation, url: topic.url, title: topic.title },
    sources,
    availableSources: topic.sources.map((source) => ({ ...source, ...(source.archivePasswords ? { archivePasswords: [...source.archivePasswords] } : {}) })),
    destination: downloadDestination(value.destination),
    again: value.again === true,
  }
}

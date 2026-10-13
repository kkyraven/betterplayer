import { isEroTopicUrl } from '@shared/eroscripts'
import type { BrowserTab } from '@shared/browser'
import type { DownloadBatch } from '@shared/downloads'

export function topicNumber(url: string): string | null {
  if (!isEroTopicUrl(url)) return null
  const segments = new URL(url).pathname.split('/')
  return /^\d+$/.test(segments[2] ?? '') ? segments[2]! : segments[3] ?? null
}

export function topicTab(batch: Pick<DownloadBatch, 'topicTabId' | 'topicUrl'>, tabs: readonly Pick<BrowserTab, 'id' | 'url'>[]): number | null {
  const tab = tabs.find((candidate) => candidate.id === batch.topicTabId)
  if (!tab) return null
  const topic = topicNumber(batch.topicUrl)
  const same = topic === null ? tab.url === batch.topicUrl : topicNumber(tab.url) === topic
  return same ? tab.id : null
}

import { isEroTopicUrl, type EroTopic } from '@shared/eroscripts'
import type { BrowserTab } from '@shared/browser'
import type { DownloadBatch } from '@shared/downloads'

export function topicNumber(url: string): string | null {
  if (!isEroTopicUrl(url)) return null
  const segments = new URL(url).pathname.split('/')
  return /^\d+$/.test(segments[2] ?? '') ? segments[2]! : segments[3] ?? null
}

export function topicTab(batch: Pick<DownloadBatch, 'topicTabId' | 'topicUrl'>, tabs: readonly Pick<BrowserTab, 'id' | 'url'>[]): number | null {
  const topic = topicNumber(batch.topicUrl)
  const same = (tab: Pick<BrowserTab, 'url'>) => topic === null ? tab.url === batch.topicUrl : topicNumber(tab.url) === topic
  const captured = tabs.find((tab) => tab.id === batch.topicTabId)
  if (captured && same(captured)) return captured.id
  return topic === null ? null : tabs.find(same)?.id ?? null
}

export function isTopicBatch(topic: Pick<EroTopic, 'url'>, batch: Pick<DownloadBatch, 'origin' | 'topicUrl'>): boolean {
  const id = topicNumber(topic.url)
  return batch.origin !== 'browser' && id !== null && topicNumber(batch.topicUrl) === id
}

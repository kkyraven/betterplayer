import { describe, expect, it } from 'vitest'
import { isTopicBatch, topicTab } from './topicTab'

const batch = { topicTabId: 4, topicUrl: 'https://discuss.eroscripts.com/t/test-files/123' }

describe('download topic tab', () => {
  it('reuses the captured tab while it shows the same topic at any slug, post or query', () => {
    for (const url of ['https://discuss.eroscripts.com/t/test-files/123', 'https://discuss.eroscripts.com/t/renamed/123/18?u=me', 'https://discuss.eroscripts.com/t/123/5']) {
      expect(topicTab(batch, [{ id: 4, url }])).toBe(4)
    }
  })

  it('uses another tab on the topic, or none, when the captured tab closed or moved to another page', () => {
    expect(topicTab(batch, [{ id: 7, url: batch.topicUrl }])).toBe(7)
    expect(topicTab(batch, [{ id: 4, url: 'https://discuss.eroscripts.com/t/test-files/1234' }, { id: 7, url: 'https://discuss.eroscripts.com/t/123/2' }])).toBe(7)
    expect(topicTab(batch, [{ id: 4, url: 'https://discuss.eroscripts.com/t/test-files/1234' }])).toBeNull()
    expect(topicTab(batch, [{ id: 4, url: 'https://discuss.eroscripts.com/latest' }])).toBeNull()
    expect(topicTab(batch, [{ id: 4, url: 'https://example.org/t/test-files/123' }])).toBeNull()
  })

  it('requires the exact page for batches that did not start from a topic', () => {
    const browser = { topicTabId: 2, topicUrl: 'https://example.org/files' }
    expect(topicTab(browser, [{ id: 2, url: 'https://example.org/files' }])).toBe(2)
    expect(topicTab(browser, [{ id: 2, url: 'https://example.org/other' }])).toBeNull()
  })

  it('recognises batches from this topic in any tab', () => {
    const topic = { url: 'https://discuss.eroscripts.com/t/renamed/123/9' }
    expect(isTopicBatch(topic, batch)).toBe(true)
    expect(isTopicBatch(topic, { ...batch, topicUrl: 'https://discuss.eroscripts.com/t/other/124' })).toBe(false)
    expect(isTopicBatch(topic, { ...batch, origin: 'browser' })).toBe(false)
  })
})

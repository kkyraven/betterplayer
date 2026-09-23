import { describe, expect, it } from 'vitest'
import { handoffHeaders, handoffState, mediaUrl } from './handoff'

describe('browser media handoff', () => {
  it('preserves signed network sources and rejects browser-only or credentialed URLs', () => {
    const url = 'https://cdn.example/video.mp4?token=abc%2Fdef&expires=123'
    expect(mediaUrl(url)).toBe(url)
    for (const source of ['blob:https://example.com/123', 'data:video/mp4;base64,abc', 'file:///video.mp4', 'javascript:alert(1)', 'https://user:pass@example.com/a.mp4', 'https://example.com/a\r\nInjected: true']) {
      expect(mediaUrl(source)).toBeNull()
    }
  })

  it('keeps the fresh position and rate when a source needs extraction', () => {
    expect(handoffState({ requestId: 7, url: 'blob:https://example.com/a', position: 32.5, rate: 1.5 }))
      .toEqual({ requestId: 7, url: null, position: 32.5, rate: 1.5 })
    for (const position of [NaN, Infinity, -1, '32']) {
      expect(handoffState({ requestId: 7, url: null, position, rate: 1 })).toBeNull()
    }
    expect(handoffState({ requestId: 7, url: null, position: 32, rate: 0 })).toBeNull()
    expect(handoffState(null)).toBeNull()
  })

  it('rejects header values that can add mpv list fields', () => {
    expect(handoffHeaders('https://player.example/watch/1', 'Browser/1'))
      .toBe('Referer: https://player.example/watch/1,User-Agent: Browser/1')
    expect(handoffHeaders('https://example.com/a,Injected:true', 'Browser\r\nInjected: true')).toBe('')
    expect(handoffHeaders('https://example.com/a', 'Browser\\Injected')).toBe('Referer: https://example.com/a')
  })
})

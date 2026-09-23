import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptySession, mostVisited, parseSession, readSession, writeSession } from './storage'

describe('browser session storage', () => {
  it('round trips ordered tabs, active history position, bookmarks and adblock setting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-session-'))
    try {
      const path = join(dir, 'session.json')
      const state = emptySession()
      state.tabs = [
        { url: 'https://example.com/one', title: 'One', entries: [{ url: 'https://example.com/one', title: 'One', pageState: 'state' }, { url: 'https://example.com/two', title: 'Two' }], index: 0 },
        { url: 'about:blank', title: '', entries: [], index: 0 },
      ]
      state.activeIndex = 1
      state.adBlockEnabled = false
      state.bookmarks = [{ url: 'https://example.com/', title: 'Example' }]
      writeSession(path, state)
      expect(readSession(path)).toEqual(state)
      state.activeIndex = 0
      writeSession(path, state)
      expect(JSON.parse(readFileSync(path, 'utf8')).activeIndex).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ignores corrupt records and unsafe restored schemes', () => {
    expect(parseSession(null)).toEqual(emptySession())
    const state = parseSession({ version: 1, tabs: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/', entries: [], index: -3 }], activeIndex: 100, history: [{ url: 'invalid', visits: 3, lastVisited: 10 }], bookmarks: [{ url: 'file:///secret' }] })
    expect(state.tabs).toHaveLength(1)
    expect(state.activeIndex).toBe(0)
    expect(state.history).toEqual([])
    expect(state.bookmarks).toEqual([])
  })

  it('keeps icons only for hosts still in history or bookmarks, and only web URLs', () => {
    const state = parseSession({ version: 1, tabs: [], activeIndex: 0,
      history: [{ url: 'https://a.example/', title: 'A', visits: 1, lastVisited: 1 }],
      bookmarks: [{ url: 'https://b.example/', title: 'B' }],
      icons: { 'a.example': 'https://a.example/icon.png', 'b.example': 'https://cdn.example/b.svg', 'gone.example': 'https://gone.example/icon.png', 'c.example': 'javascript:alert(1)' } })
    expect(state.icons).toEqual({ 'a.example': 'https://a.example/icon.png', 'b.example': 'https://cdn.example/b.svg' })
  })

  it('groups most visited by site and chooses the latest page within each site', () => {
    expect(mostVisited([
      { url: 'https://a.example/old', title: 'Old', visits: 3, lastVisited: 1 },
      { url: 'https://b.example/', title: 'B', visits: 4, lastVisited: 2 },
      { url: 'https://a.example/new', title: 'New', visits: 2, lastVisited: 3 },
    ])).toEqual([
      { url: 'https://a.example/new', title: 'New', visits: 5, lastVisited: 3 },
      { url: 'https://b.example/', title: 'B', visits: 4, lastVisited: 2 },
    ])
  })
})

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserBookmark, BrowserVisitedSite } from '@shared/browser'

export interface SavedTab {
  url: string
  title: string
  entries: { url: string; title: string; pageState?: string }[]
  index: number
}

export interface BrowserSession {
  version: 1
  tabs: SavedTab[]
  activeIndex: number
  bookmarks: BrowserBookmark[]
  history: BrowserVisitedSite[]
  icons: Record<string, string>
  adBlockEnabled: boolean
}

export function emptySession(): BrowserSession {
  return { version: 1, tabs: [], activeIndex: 0, bookmarks: [{ url: 'https://agenticlover.ai/', title: 'agenticlover.ai' }], history: [], icons: {}, adBlockEnabled: true }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function webUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

export function parseSession(value: unknown): BrowserSession {
  const result = emptySession()
  if (!record(value) || value.version !== 1) return result
  result.bookmarks = []
  result.adBlockEnabled = value.adBlockEnabled !== false
  if (Array.isArray(value.tabs)) for (const tab of value.tabs) {
    if (!record(tab) || !(webUrl(tab.url) || tab.url === 'about:blank')) continue
    const entries: SavedTab['entries'] = []
    if (Array.isArray(tab.entries)) for (const entry of tab.entries) {
      if (!record(entry) || !(webUrl(entry.url) || entry.url === 'about:blank')) continue
      entries.push({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : '', ...(typeof entry.pageState === 'string' ? { pageState: entry.pageState } : {}) })
    }
    result.tabs.push({ url: tab.url, title: typeof tab.title === 'string' ? tab.title : '', entries,
      index: typeof tab.index === 'number' && Number.isInteger(tab.index) ? Math.max(0, Math.min(tab.index, entries.length - 1)) : Math.max(0, entries.length - 1) })
  }
  result.activeIndex = typeof value.activeIndex === 'number' && Number.isInteger(value.activeIndex) ? Math.max(0, Math.min(value.activeIndex, result.tabs.length - 1)) : 0
  if (Array.isArray(value.bookmarks)) for (const bookmark of value.bookmarks) {
    if (record(bookmark) && webUrl(bookmark.url) && !result.bookmarks.some((b) => b.url === bookmark.url)) {
      result.bookmarks.push({ url: bookmark.url, title: typeof bookmark.title === 'string' ? bookmark.title : bookmark.url })
    }
  }
  if (Array.isArray(value.history)) for (const site of value.history) {
    if (record(site) && webUrl(site.url) && typeof site.visits === 'number' && Number.isFinite(site.visits) && site.visits > 0 && typeof site.lastVisited === 'number' && Number.isFinite(site.lastVisited)) {
      result.history.push({ url: site.url, title: typeof site.title === 'string' ? site.title : site.url, visits: site.visits, lastVisited: site.lastVisited })
    }
  }
  result.history = result.history.slice(-2000)
  if (record(value.icons)) {
    const hosts = new Set([...result.history, ...result.bookmarks].map((site) => new URL(site.url).hostname))
    for (const [host, icon] of Object.entries(value.icons)) if (hosts.has(host) && webUrl(icon)) result.icons[host] = icon
  }
  return result
}

export function readSession(path: string): BrowserSession {
  try { return parseSession(JSON.parse(readFileSync(path, 'utf8'))) } catch { return emptySession() }
}

export function writeSession(path: string, state: BrowserSession) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function mostVisited(history: BrowserVisitedSite[]): BrowserVisitedSite[] {
  const sites = new Map<string, BrowserVisitedSite>()
  for (const visit of history) {
    const host = new URL(visit.url).hostname
    const previous = sites.get(host)
    sites.set(host, previous ? { ...(visit.lastVisited > previous.lastVisited ? visit : previous), visits: previous.visits + visit.visits, lastVisited: Math.max(previous.lastVisited, visit.lastVisited) } : { ...visit })
  }
  return [...sites.values()].sort((a, b) => b.visits - a.visits || b.lastVisited - a.lastVisited).slice(0, 10)
}

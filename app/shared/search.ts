import type { MessageKey } from './i18n'
export const SEARCH_FIELDS = ['title', 'performer', 'tag', 'description', 'studio', 'folder', 'filename', 'playlist', 'source', 'script'] as const
export type SearchField = (typeof SEARCH_FIELDS)[number]

export interface Performer {
  id: number
  name: string
  aliases: string[]
}

export interface ImportedPerformer {
  key: string
  name: string
  aliases: string[]
}

export interface SearchMatch {
  field: SearchField
  text: string
  ranges: [number, number][]
}

export interface SearchInfo {
  query: string
  conditions: string[]
  corrections: { from: string; to: string }[]
  error?: string
}

export const SEARCH_LABELS: Record<SearchField, MessageKey> = {
  title: 'searchField.title', performer: 'searchField.performer', tag: 'searchField.tag', description: 'searchField.description', studio: 'searchField.studio', folder: 'searchField.folder', filename: 'searchField.filename', playlist: 'searchField.playlist', source: 'searchField.source', script: 'searchField.script',
}

export const SEARCH_MAX_LENGTH = 512

export function normalizeSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_\p{Pd}]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function searchWords(text: string): string[] {
  return normalizeSearch(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

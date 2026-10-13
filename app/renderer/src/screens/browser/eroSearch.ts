import { EROSCRIPTS_HOME } from '@shared/eroscripts'

export const ERO_SORTS = ['', 'latest', 'latest_topic', 'likes'] as const
export type EroSort = typeof ERO_SORTS[number]

export interface EroSearch {
  text: string
  category: string
  tags: string
  tagMode: 'all' | 'any'
  excludeTags: string
  author: string
  after: string
  before: string
  titleOnly: boolean
  firstPost: boolean
  sort: EroSort
}

export const emptyEroSearch = (): EroSearch => ({
  text: '', category: '', tags: '', tagMode: 'all', excludeTags: '', author: '', after: '', before: '',
  titleOnly: false, firstPost: false, sort: '',
})

const slug = /^[a-zA-Z0-9_/-]+$/
const date = /^\d{4}-\d{2}-\d{2}$/
function tokens(text: string): string[] {
  const parts: string[] = []
  let start = -1
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (start < 0) {
      if (/\s/.test(char)) continue
      start = index
    }
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') quoted = !quoted
    else if (!quoted && /\s/.test(char)) { parts.push(text.slice(start, index)); start = -1 }
  }
  if (start >= 0) parts.push(text.slice(start))
  return parts
}

export function parseEroSearch(query: string): EroSearch {
  const result = emptyEroSearch()
  const parts = tokens(query)
  const counts = new Map<string, number>()
  const family = (token: string) => token.startsWith('@') ? '@' : token.match(/^(-?\w+:)/)?.[1] ?? token
  for (const token of parts) counts.set(family(token), (counts.get(family(token)) ?? 0) + 1)
  const kept: string[] = []
  for (const token of parts) {
    const key = family(token)
    const value = token.slice(key.length)
    if (counts.get(key) !== 1 && key !== 'in:') { kept.push(token); continue }
    if (key === 'category:' && slug.test(value)) result.category = value
    else if (key === 'tags:' && (/^[\w/-]+(?:\+[\w/-]+)*$/.test(value) || /^[\w/-]+(?:,[\w/-]+)*$/.test(value))) {
      result.tags = value.replace(/[+,]/g, ', ')
      result.tagMode = value.includes(',') ? 'any' : 'all'
    } else if (key === '-tags:' && /^[\w/-]+(?:,[\w/-]+)*$/.test(value)) result.excludeTags = value.replace(/,/g, ', ')
    else if (key === '@' && /^[\w.-]+$/.test(value)) result.author = value
    else if (key === 'after:' && validDate(value)) result.after = value
    else if (key === 'before:' && validDate(value)) result.before = value
    else if (token === 'in:title' && !result.titleOnly) result.titleOnly = true
    else if (token === 'in:first' && !result.firstPost) result.firstPost = true
    else if (key === 'order:' && value && ERO_SORTS.some((sort) => sort === value)) result.sort = ERO_SORTS.find((sort) => sort === value) ?? ''
    else kept.push(token)
  }
  result.text = kept.join(' ')
  return result
}

function validDate(value: string): boolean {
  if (!date.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function eroSearchError(search: EroSearch): 'category' | 'tags' | 'author' | 'dates' | null {
  if (search.category && !slug.test(search.category)) return 'category'
  const tags = [search.tags, search.excludeTags].flatMap((value) => value.split(/[,\s]+/).filter(Boolean))
  if (tags.some((value) => !slug.test(value))) return 'tags'
  if (search.author && !/^[\w.-]+$/.test(search.author.replace(/^@/, ''))) return 'author'
  if ((search.after && !validDate(search.after)) || (search.before && !validDate(search.before))
    || (search.after && search.before && search.after > search.before)) return 'dates'
  return null
}

export function eroSearchQuery(search: EroSearch): string {
  const tagList = (value: string) => value.split(/[,\s]+/).filter(Boolean)
  return [search.text.trim(), search.category && `category:${search.category}`,
    search.tags && `tags:${tagList(search.tags).join(search.tagMode === 'all' ? '+' : ',')}`,
    search.excludeTags && `-tags:${tagList(search.excludeTags).join(',')}`,
    search.author && `@${search.author.replace(/^@/, '')}`,
    search.after && `after:${search.after}`, search.before && `before:${search.before}`,
    search.titleOnly && 'in:title', search.firstPost && 'in:first', search.sort && `order:${search.sort}`,
  ].filter(Boolean).join(' ')
}

export function eroSearchUrl(search: EroSearch): string {
  return `${EROSCRIPTS_HOME}search?q=${encodeURIComponent(eroSearchQuery(search))}`
}

export function searchQueryFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.pathname.replace(/\/$/, '') === '/search' ? url.searchParams.get('q') ?? '' : null
  } catch { return null }
}

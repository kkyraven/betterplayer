import type { MediaFilters } from '@shared/library'

export type TagClick = 'only' | 'add' | 'exclude'

export const tagClick = (e: { shiftKey: boolean; altKey: boolean }): TagClick => (e.altKey ? 'exclude' : e.shiftKey ? 'add' : 'only')

export function tagState(f: MediaFilters, name: string): 'in' | 'out' | undefined {
  return f.tags?.includes(name) ? 'in' : f.notTags?.includes(name) ? 'out' : undefined
}

const list = (names: string[]) => (names.length ? names : undefined)

export function clickTag(f: MediaFilters, name: string, click: TagClick): MediaFilters {
  const state = tagState(f, name)
  const tags = (f.tags ?? []).filter((n) => n !== name)
  const notTags = (f.notTags ?? []).filter((n) => n !== name)
  if (click === 'only') return { ...f, tags: state === 'in' && !tags.length && !notTags.length ? undefined : [name], notTags: undefined }
  if (click === 'add') return { ...f, tags: list(state === 'in' ? tags : [...tags, name]), notTags: list(notTags) }
  return { ...f, tags: list(tags), notTags: list(state === 'out' ? notTags : [...notTags, name]) }
}

export function retargetTags(f: MediaFilters, names: string[], into: string | undefined): MediaFilters {
  const swap = (xs: string[] | undefined) => xs && list([...new Set(xs.flatMap((n) => (names.includes(n) ? (into ? [into] : []) : [n])))])
  return { ...f, tags: swap(f.tags), notTags: swap(f.notTags) }
}

import type { EroFacets } from '@shared/eroscripts'

const SLUG = /^[\w-]+$/
const TAG = /^[\w/-]+$/

function records(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || !(key in value)) return []
  const list: unknown = (value as Record<string, unknown>)[key]
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
}

export function eroFacets(site: unknown, tagList: unknown): EroFacets {
  const raw = records(site, 'categories')
  const names = new Map(raw.map((category) => [category.id, category.name]))
  const categories: EroFacets['categories'] = []
  for (const category of raw) {
    const { slug, name } = category
    if (typeof slug !== 'string' || !SLUG.test(slug) || typeof name !== 'string' || !name.trim()) continue
    const parent = names.get(category.parent_category_id)
    categories.push({ slug, name: (typeof parent === 'string' ? `${parent} / ${name}` : name).slice(0, 100) })
  }
  const counts = new Map<string, number>()
  for (const tag of records(tagList, 'tags')) {
    if (typeof tag.name === 'string' && TAG.test(tag.name) && tag.pm_only !== true) counts.set(tag.name, typeof tag.count === 'number' ? tag.count : 0)
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)
  return { categories: categories.sort((a, b) => a.name.localeCompare(b.name)), tags }
}

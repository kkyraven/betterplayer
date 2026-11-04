import { describe, expect, it } from 'vitest'
import { eroFacets } from './facets'

describe('EroScripts search suggestions', () => {
  it('names subcategories under their parent and orders tags by use', () => {
    const site = { categories: [
      { id: 8, slug: 'general', name: 'General', parent_category_id: null },
      { id: 22, slug: 'sales', name: 'Sales', parent_category_id: 8 },
    ] }
    const tags = { tags: [{ name: 'pmv', count: 40 }, { name: 'vr', count: 151 }, { name: 'hentai', count: 149 }] }
    expect(eroFacets(site, tags)).toEqual({
      categories: [{ slug: 'general', name: 'General' }, { slug: 'sales', name: 'General / Sales' }],
      tags: ['vr', 'hentai', 'pmv'],
    })
  })
  it('drops values search would reject and tolerates malformed responses', () => {
    const site = { categories: [{ id: 1, slug: 'bad slug', name: 'Bad' }, null, { id: 2, slug: 'ok', name: ' ' }] }
    const tags = { tags: [{ name: 'has space', count: 9 }, { name: 'private', count: 9, pm_only: true }, 'vr'] }
    expect(eroFacets(site, tags)).toEqual({ categories: [], tags: [] })
    expect(eroFacets('<html>', null)).toEqual({ categories: [], tags: [] })
  })
})

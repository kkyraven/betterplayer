import { describe, expect, it } from 'vitest'
import { ENGLISH, createTranslator } from '@shared/i18n'
import type { LibraryCounts } from '@shared/library'
import { localHits, SESSION_SECTIONS } from './search'

const t = createTranslator('en', ENGLISH)
const counts = Object.fromEntries(SESSION_SECTIONS.map((s) => [s, 3])) as LibraryCounts

describe('localHits', () => {
  it('matches views by their translated name', () => {
    const hits = localHits('favour', [], [], [], counts, t)
    expect(hits).toEqual([{ ref: { kind: 'section', section: 'favourites' }, count: 3 }])
  })

  it('does not match views by their i18n key', () => {
    expect(localHits('library.section', [], [], [], counts, t)).toEqual([])
  })
})

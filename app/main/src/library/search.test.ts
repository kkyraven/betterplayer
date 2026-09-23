import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPlaylist, type MediaQuery } from '@shared/library'
import { createTranslator } from '@shared/i18n'
import { LibraryDb, type MediaUpsert } from './db'
import { parseSearch } from './search-query'
import { spellingDistance } from './search-index'

describe('query interpretation', () => {
  it('translates descriptions and errors without changing the search grammar or SQL', () => {
    const t = createTranslator('en', {
      'library.search.under': 'Moins de {amount}',
      'library.search.notCondition': 'Non {condition}',
      'library.filter.watched': 'vu',
      'library.search.condition.rating': 'note : {value}',
      'library.search.invalidRating': 'Note invalide',
      'library.search.invalidTitle': 'Titre invalide',
    })
    const query = 'under 20 minutes -watched rating:>=3'
    const translated = parseSearch(query, t)
    expect(translated.info.conditions).toEqual(['Moins de 20 minutes', 'Non vu', 'note : >=3'])
    expect(translated.groups.flat().map((term) => term.kind === 'filter' ? { sql: term.sql, params: term.params, exclude: term.exclude } : term))
      .toEqual(parseSearch(query).groups.flat().map((term) => term.kind === 'filter' ? { sql: term.sql, params: term.params, exclude: term.exclude } : term))
    expect(parseSearch('rating:9', t).info.error).toBe('Note invalide')
    expect(parseSearch('title:', t).info.error).toBe('Titre invalide')
  })

  it('combines names and text with natural metadata conditions', () => {
    const plan = parseSearch('Mira coast 4K under 20 minutes unwatched with scripts')
    expect(plan.info.error).toBeUndefined()
    expect(plan.groups[0]?.filter((t) => t.kind === 'text').map((t) => t.value)).toEqual(['mira', 'coast'])
    expect(plan.info.conditions).toEqual(['4K', 'Under 20 minutes', 'Unwatched', 'Has script'])
  })

  it.each(['duration:banana', 'duration:<-3m', 'rating:9', 'added:2026-02-31', 'axis:ZZ', 'OR coast', 'coast OR', '"coast', 'coast AND', '%_', 'x'.repeat(513)])('rejects invalid input without dropping conditions: %s', (input) => {
    expect(parseSearch(input).info.error).toBeTruthy()
  })

  it('keeps quoted conditions literal and unknown words searchable', () => {
    const plan = parseSearch('"unwatched" relaxing unknown:value')
    expect(plan.groups[0]?.every((t) => t.kind === 'text')).toBe(true)
    expect(plan.groups[0]?.[0]).toMatchObject({ value: 'unwatched', exact: true })
  })

  it('recognizes phrases, field restrictions, negation, and alternatives', () => {
    const plan = parseSearch('performer:"Mira Vale" -tag:rain OR "coast walk"')
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups[0]?.[0]).toMatchObject({ field: 'performer', value: 'mira vale', exact: true })
    expect(plan.groups[0]?.[1]).toMatchObject({ field: 'tag', value: 'rain', exclude: true, exact: true })
  })

  it('counts adjacent transpositions as one spelling error', () => {
    expect(spellingDistance('caost', 'coast', 1)).toBe(1)
    expect(spellingDistance('coast', 'forest', 1)).toBeGreaterThan(1)
  })
})

describe('local library search', () => {
  let db: LibraryDb
  let root: number
  let counter = 0
  const query = (search: string, overrides: Partial<MediaQuery> = {}): MediaQuery => ({ section: 'all', sort: 'recommended', desc: true, filters: {}, limit: 120, offset: 0, search, ...overrides })
  const ids = (search: string, overrides: Partial<MediaQuery> = {}) => db.queryIds(query(search, overrides))
  const add = (title: string, extra: Partial<MediaUpsert> = {}) => db.upsertMedia({ rootId: root, path: `/fictional/${++counter}.mp4`, folder: '', title, size: 100_000, mtime: 1000, durationMs: 600_000, width: 3840, height: 2160, codec: 'hevc', projection: 'flat', ...extra }, counter)
  const metadata = (id: number, description = '', name = 'Mira Vale') => db.setMetadata(id, { description, studio: 'Field Studio', filename: 'sample.mp4', performers: [{ key: 'person-1', name, aliases: ['MV'] }] })
  beforeEach(() => { db = new LibraryDb(':memory:'); root = db.addRoot('/fictional').id; counter = 0 })
  afterEach(() => db.close())

  it('matches across performers, tags and metadata without adding performer tags', () => {
    const wanted = add('Harbour')
    metadata(wanted)
    db.setTags(wanted, ['coast', 'outdoor'])
    add('Mira coast', { height: 1080 })
    expect(ids('Mira coast 4k under 20 minutes unwatched')).toEqual([wanted])
    expect(ids('MV')).toEqual([wanted])
    expect(ids('performer:"Mira Vale" tag:coast')).toEqual([wanted])
    expect(db.mediaRow(wanted)?.tags).toEqual(['coast', 'outdoor'])
    expect(db.metadata(wanted).performers[0]?.name).toBe('Mira Vale')
  })

  it('searches descriptions, source names, folders, filenames, playlists and script names', () => {
    const wanted = add('Harbour', { folder: 'Cliffs', path: '/fictional/camera-original.mp4' })
    metadata(wanted, 'An outdoor journey near the coast.')
    const playlist = db.createPlaylist('Weekend collection')
    db.addToPlaylist(playlist.id, [wanted])
    db.setScripts(wanted, [{ axis: 'L0', source: '/fictional/waves.funscript', container: '', actions: 10, averageSpeed: 50, maxSpeed: 90, heatmap: [], durationMs: 600_000 }], { axes: ['L0'], averageSpeed: 50, heat: [] })
    for (const text of ['description:journey', 'studio:Field', 'folder:Cliffs', 'filename:sample', 'playlist:Weekend', 'script:waves', 'source:fictional', 'axis:L0 speed:>40']) expect(ids(text)).toEqual([wanted])
    const page = db.query(query('journey'))
    const row = page.rows[0]
    expect(row && !isPlaylist(row) && row.searchMatch).toMatchObject({ field: 'description' })
  })

  it('ranks exact text before prefixes, then by field weight with stable paging', () => {
    const description = add('One'); metadata(description, 'coast')
    const prefix = add('Coastal')
    const tag = add('Two'); db.setTags(tag, ['coast'])
    const title = add('Coast')
    const ordered = ids('coast')
    expect(ordered).toEqual([title, tag, description, prefix])
    const first = db.query(query('coast', { limit: 2 }))
    const next = db.query(query('coast', { limit: 2, offset: 2 }))
    expect([...first.rows, ...next.rows].map((r) => r.id)).toEqual(ordered)
    expect(first.total).toBe(4)
    expect(next.total).toBeNull()
    expect(first.rev).toBe(next.rev)
    expect(db.jump(query('coast'), 'two')).toEqual({ index: 1, id: tag })
  })

  it('corrects a typo without loosening negation or explicit fields', () => {
    const coast = add('Coast')
    expect(ids('caost')).toEqual([coast])
    expect(db.query(query('caost')).search?.corrections).toContainEqual({ from: 'caost', to: 'coast' })
    expect(ids('title:caost')).toEqual([])
    expect(ids('-caost')).toEqual([coast])
    expect(ids('-coast')).toEqual([])
  })

  it('requires all tags and applies OR within existing filters', () => {
    const coast = add('Coast'); db.setTags(coast, ['outdoor', 'nature'])
    const rain = add('Rain'); db.setTags(rain, ['outdoor', 'rain'])
    expect(ids('tag:outdoor tag:nature -tag:rain')).toEqual([coast])
    expect(ids('coast OR rain')).toHaveLength(2)
    expect(ids('coast OR rain', { filters: { tag: 'nature' } })).toEqual([coast])
    expect(ids('"coast rain"')).toEqual([])
    expect(ids('coast duration:broken')).toEqual([])
  })

  it('applies numeric units and treats missing measurements as unknown', () => {
    const known = add('Coast', { durationMs: 90_000, size: 2_000_000 })
    add('Coast unknown', { durationMs: 0, height: 0, size: 0 })
    expect(ids('under 2 minutes size:>=1mb resolution:>=1080p codec:hevc')).toEqual([known])
    expect(ids('duration:<1m')).toEqual([])
  })

  it('keeps hidden and excluded rows out of results and spelling corrections', () => {
    const hidden = add('Waterfall'); db.setHidden([hidden], true)
    const excluded = add('Coast', { folder: 'Private/sub' }); db.excludeFolder({ rootId: root, folder: 'Private' })
    expect(ids('coast OR waterfall')).toEqual([])
    expect(db.query(query('watrefall')).search?.corrections).toEqual([])
    expect(ids('waterfall', { filters: { hidden: 'yes' } })).toEqual([hidden])
    db.includeFolder({ rootId: root, folder: 'Private' })
    expect(ids('coast')).toEqual([excluded])
  })

  it('interprets a date as the full local day and accepts uppercase filter values', () => {
    const day = add('Coast', { mtime: new Date('2026-09-06T13:20:00').getTime() })
    const next = add('Forest', { mtime: new Date('2026-09-07T00:00:00').getTime() })
    expect(ids('modified:2026-09-06 resolution:4K script:MISSING')).toEqual([day])
    expect(ids('modified:<=2026-09-06')).toEqual([day])
    expect(ids('modified:>2026-09-06')).toEqual([next])
  })

  it('preserves pins, explicit sort, folder scope, and playlist position order', () => {
    const a = add('Coast A', { folder: 'A' }); const b = add('Coast B', { folder: 'B' })
    expect(ids('coast', { folder: { rootId: root, folder: 'A' } })).toEqual([a])
    db.setPinned([b], 100)
    expect(ids('coast')[0]).toBe(b)
    db.setPinned([b], 0)
    expect(ids('coast', { sort: 'name', desc: true })).toEqual([b, a])
    const p = db.createPlaylist('Coast collection'); db.addToPlaylist(p.id, [b, a])
    expect(ids('coast', { playlistId: p.id })).toEqual([b, a])
  })

  it('updates the index after renames, tag edits, playlist changes and deletions', () => {
    const video = add('Coast'); metadata(video, 'A journey')
    db.setTags(video, ['outdoor'])
    const p = db.createPlaylist('Weekend'); db.addToPlaylist(p.id, [video])
    const initial = db.query(query('coast')).rev
    db.setTitle(video, 'Forest'); db.renameTag('outdoor', 'nature'); db.renamePlaylist(p.id, 'Holiday')
    expect(ids('coast OR outdoor OR Weekend')).toEqual([])
    expect(ids('forest nature holiday')).toEqual([video])
    expect(db.query(query('forest')).rev).not.toBe(initial)
    metadata(video, 'River', 'Alex Rowan')
    expect(ids('Mira OR journey')).toEqual([])
    expect(ids('Alex River')).toEqual([video])
    db.deletePlaylist(p.id)
    expect(ids('Holiday')).toEqual([])
    db.removeMedia([video])
    expect(ids('forest OR Alex OR River')).toEqual([])
  })

  it('normalizes accents, filename separators and punctuation safely', () => {
    const video = add('Café_coast-walk')
    expect(ids('cafe coast walk')).toEqual([video])
    expect(ids('"café coast"')).toEqual([video])
    for (const input of ['"', '*', '" OR 1=1 --', "';DROP TABLE media;--", 'title:']) expect(() => db.query(query(input))).not.toThrow()
    expect(db.mediaRow(video)?.title).toBe('Café_coast-walk')
  })

  it('explains token matches without highlighting a substring in an unrelated field', () => {
    const video = add('Planning'); metadata(video, 'Café, coast walk', 'Ann Vale')
    const match = (search: string) => {
      const row = db.query(query(search)).rows[0]
      return row && !isPlaylist(row) ? row.searchMatch : undefined
    }
    expect(match('Ann')).toMatchObject({ field: 'performer', text: 'Ann Vale', ranges: [[0, 3]] })
    expect(match('"cafe coast"')).toMatchObject({ field: 'description', text: 'Café, coast walk', ranges: [[0, 11]] })
    expect(match('MV')).toMatchObject({ field: 'performer', text: 'MV', ranges: [[0, 2]] })
  })

  it('never indexes remote URLs or credentials', () => {
    const remote = db.addServer({ url: 'https://user:secret@example.invalid/private', name: 'Sample server', kind: 'stash', username: 'user', secret: 'key-secret' })
    const video = add('Coast', { rootId: remote.id, path: 'https://example.invalid/stream?token=secretvalue', remoteKey: '1' })
    expect(ids('secretvalue OR secret OR token OR private')).toEqual([])
    expect(ids('source:Sample')).toEqual([video])
  })

  it('keeps same-name performers separate across roots', () => {
    const a = add('Coast A'); metadata(a)
    const other = db.addRoot('/other-fictional').id
    const b = add('Coast B', { rootId: other }); metadata(b)
    expect(db.metadata(a).performers[0]?.id).not.toBe(db.metadata(b).performers[0]?.id)
    expect(ids('performer:"Mira Vale"')).toHaveLength(2)
  })
})

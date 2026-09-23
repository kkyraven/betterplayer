import { t } from '../i18n'
import { setImmediate as yieldThread } from 'node:timers/promises'
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { SEARCH_FIELDS, searchWords, type SearchMatch } from '@shared/search'
import { parseSearch, type SearchPlan, type TextTerm } from './search-query'

const WEIGHTS = '12,10,8,1,5,3,4,3,2,2'
const BATCH = 128
const getText = (row: Record<string, SQLOutputValue>, key: string) => typeof row[key] === 'string' ? row[key] : ''

export const SEARCH_SCHEMA = `
CREATE TABLE media_details (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '', studio TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
  import_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE performers (
  id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  UNIQUE(root_id, source_key)
);
CREATE TABLE media_performers (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  performer_id INTEGER NOT NULL REFERENCES performers(id) ON DELETE CASCADE,
  PRIMARY KEY(media_id, performer_id)
);
CREATE INDEX media_performers_person ON media_performers(performer_id);
CREATE VIRTUAL TABLE search_fts USING fts5(${SEARCH_FIELDS.join(', ')}, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search_fts, 'row');
CREATE TABLE search_pending (id INTEGER PRIMARY KEY);
INSERT INTO search_pending SELECT id FROM media;
CREATE TRIGGER search_media_insert AFTER INSERT ON media BEGIN INSERT INTO search_pending VALUES (new.id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER search_media_update AFTER UPDATE OF title, path, folder, root_id ON media BEGIN INSERT INTO search_pending VALUES (new.id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER search_media_delete AFTER DELETE ON media BEGIN INSERT INTO search_pending VALUES (old.id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER search_root_update AFTER UPDATE OF name, path ON roots BEGIN INSERT INTO search_pending SELECT id FROM media WHERE root_id = new.id ON CONFLICT DO NOTHING; END;
${['media_tags', 'media_performers', 'playlist_items', 'scripts', 'media_details'].flatMap((table) => ['INSERT', 'DELETE', 'UPDATE'].map((event) => `
CREATE TRIGGER search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
  INSERT INTO search_pending VALUES (${event === 'DELETE' ? 'old' : 'new'}.media_id) ON CONFLICT DO NOTHING;
  ${event === 'UPDATE' ? 'INSERT INTO search_pending VALUES (old.media_id) ON CONFLICT DO NOTHING;' : ''}
END;`)).join('')}
CREATE TRIGGER search_tag_update AFTER UPDATE OF name ON tags BEGIN INSERT INTO search_pending SELECT media_id FROM media_tags WHERE tag_id = new.id ON CONFLICT DO NOTHING; END;
CREATE TRIGGER search_performer_update AFTER UPDATE OF name, aliases ON performers BEGIN INSERT INTO search_pending SELECT media_id FROM media_performers WHERE performer_id = new.id ON CONFLICT DO NOTHING; END;
CREATE TRIGGER search_playlist_update AFTER UPDATE OF name ON playlists BEGIN INSERT INTO search_pending SELECT media_id FROM playlist_items WHERE playlist_id = new.id ON CONFLICT DO NOTHING; END;
`

const DOCUMENT = `SELECT m.id, m.title, m.folder, m.path, r.kind, r.path root_path, r.name source,
  coalesce(d.description, '') description, coalesce(d.studio, '') studio, coalesce(d.filename, '') filename,
  (SELECT group_concat(p.name || char(10) || coalesce((SELECT group_concat(value, char(10)) FROM json_each(p.aliases)), ''), char(10)) FROM media_performers mp JOIN performers p ON p.id = mp.performer_id WHERE mp.media_id = m.id) performer,
  (SELECT group_concat(t.name, char(10)) FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id) tag,
  (SELECT group_concat(p.name, char(10)) FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.media_id = m.id) playlist,
  (SELECT group_concat(s.source, char(10)) FROM scripts s WHERE s.media_id = m.id) script
  FROM media m JOIN roots r ON r.id = m.root_id LEFT JOIN media_details d ON d.media_id = m.id WHERE m.id = ?`

function filename(path: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return ''
  return path.replace(/\\/g, '/').split('/').pop() ?? ''
}

export function spellingDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let before = previous
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j]!, before[j - 2]! + 1)
    }
    before = previous
    previous = current
  }
  return previous[b.length]!
}

const phrase = (value: string) => `"${searchWords(value).join(' ').replace(/"/g, '""')}"`
const expression = (term: TextTerm, prefix = false, value = term.value) => `${term.field ? `${term.field} : ` : ''}${phrase(value)}${prefix ? '*' : ''}`

export interface CompiledSearch {
  withSql: string
  join: string
  where: string
  order: string
  params: SQLInputValue[]
  whereParams: SQLInputValue[]
  plan: SearchPlan
}

export class SearchIndex {
  private pending: Promise<void> | null = null
  private closed = false
  private readonly read
  private readonly insert
  private readonly remove
  private readonly next
  private readonly done

  constructor(private readonly db: DatabaseSync) {
    this.read = db.prepare(DOCUMENT)
    this.insert = db.prepare(`INSERT INTO search_fts(rowid, ${SEARCH_FIELDS.join(',')}) VALUES (${SEARCH_FIELDS.map(() => '?').join(',')}, ?)`)
    this.remove = db.prepare('DELETE FROM search_fts WHERE rowid = ?')
    this.next = db.prepare('SELECT id FROM search_pending ORDER BY id LIMIT ?')
    this.done = db.prepare('DELETE FROM search_pending WHERE id = ?')
  }

  close() { this.closed = true }

  async ready(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      while (!this.closed && this.flush(BATCH)) await yieldThread()
    })().finally(() => { this.pending = null })
    return this.pending
  }

  flush(limit = BATCH): number {
    if (this.closed) return 0
    const rows = this.next.all(limit)
    if (!rows.length) return 0
    this.db.exec('SAVEPOINT search_batch')
    try {
      for (const { id } of rows) {
        this.remove.run(id ?? null)
        const row = this.read.get(id ?? null)
        if (row) {
          const values = SEARCH_FIELDS.map((field) => {
            if (field === 'filename') return getText(row, 'filename') || (row.kind === 'folder' ? filename(getText(row, 'path')) : '')
            if (field === 'source') return getText(row, 'source') || (row.kind === 'folder' ? filename(getText(row, 'root_path')) : '')
            if (field === 'script') return getText(row, 'script').split('\n').map(filename).join('\n')
            return getText(row, field)
          })
          this.insert.run(id ?? null, ...values.map((v) => v.normalize('NFKC').replace(/[_\p{Pd}]/gu, ' ')))
        }
        this.done.run(id ?? null)
      }
      this.db.exec('RELEASE search_batch')
    } catch (e) {
      this.db.exec('ROLLBACK TO search_batch; RELEASE search_batch')
      throw e
    }
    return rows.length
  }

  revision(): number {
    return Number(this.db.prepare('SELECT total_changes() n').get()?.n ?? 0)
  }

  compile(query: string, scope: { from: string; where: string; params: SQLInputValue[] }): CompiledSearch {
    while (this.flush()) { }
    const plan = parseSearch(query, t)
    const ctes: string[] = []
    const joins: string[] = []
    const scores: string[] = []
    const params: SQLInputValue[] = []
    const whereParams: SQLInputValue[] = []
    const groups = plan.groups.map((terms) => terms.map((term) => {
      if (term.kind === 'filter') {
        whereParams.push(...term.params)
        return `${term.exclude ? 'NOT ' : ''}(${term.sql})`
      }
      const n = joins.length
      const alias = `search_hit_${n}`
      const exact = expression(term)
      const queries: [string, number][] = [[exact, 0]]
      if (!term.exact) {
        const prefix = expression(term, true)
        queries.push([`${prefix} NOT ${exact}`, 100])
        const words = searchWords(term.value)
        if (words.length === 1 && words[0]!.length >= 4 && words[0]!.length <= 40) {
          const corrections = this.corrections(words[0]!, scope)
          if (corrections.length) queries.push([`(${corrections.map((word) => expression(term, false, word)).join(' OR ')}) NOT ${prefix}`, 200])
          for (const word of corrections) {
            if (!plan.info.corrections.some((c) => c.from === term.value && c.to === word)) plan.info.corrections.push({ from: term.value, to: word })
          }
        }
      }
      ctes.push(`${alias} AS MATERIALIZED (${queries.map(([match, tier]) => {
        params.push(match)
        return `SELECT rowid id, ${tier} + bm25(search_fts, ${WEIGHTS}) / (1 + abs(bm25(search_fts, ${WEIGHTS}))) score FROM search_fts WHERE search_fts MATCH ?`
      }).join(' UNION ALL ')})`)
      joins.push(` LEFT JOIN ${alias} ON ${alias}.id = m.id`)
      if (!term.exclude) scores.push(`coalesce(${alias}.score, 0)`)
      return `${alias}.id IS ${term.exclude ? '' : 'NOT '}NULL`
    }).join(' AND '))
    return {
      withSql: ctes.length ? `WITH ${ctes.join(', ')} ` : '', join: joins.join(''),
      where: plan.info.error ? '0' : groups.filter(Boolean).map((g) => `(${g})`).join(' OR ') || '1',
      order: scores.length ? `(${scores.join(' + ')}) ASC, m.id ASC` : 'm.added_at DESC, m.id ASC',
      params, whereParams, plan,
    }
  }

  private corrections(word: string, scope: { from: string; where: string; params: SQLInputValue[] }): string[] {
    const inScope = (match: string) => !!this.db.prepare(`SELECT 1 ${scope.from} WHERE ${scope.where} AND m.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) LIMIT 1`).get(...scope.params, match)
    if (inScope(`${phrase(word)}*`)) return []
    const max = word.length >= 8 ? 2 : 1
    const first = word[0]!
    const candidates = this.db.prepare('SELECT term FROM search_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ? LIMIT 512')
      .all(first, `${first}\uffff`, word.length - max, word.length + max)
      .map((r) => getText(r, 'term'))
      .map((term) => ({ term, distance: spellingDistance(word, term, max) }))
      .filter((c) => c.distance <= max)
      .sort((a, b) => a.distance - b.distance || a.term.localeCompare(b.term))
    return candidates.slice(0, 12).filter((c) => inScope(phrase(c.term))).slice(0, 3).map((c) => c.term)
  }

  match(id: number, plan: SearchPlan): SearchMatch | undefined {
    const row = this.db.prepare('SELECT * FROM search_fts WHERE rowid = ?').get(id)
    if (!row) return undefined
    const terms = plan.groups.flat().filter((t): t is TextTerm => t.kind === 'text' && !t.exclude)
    for (const field of SEARCH_FIELDS) {
      const text = getText(row, field)
      const positions: number[] = []
      let folded = ''
      let offset = 0
      for (const c of text) {
        const part = c.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        folded += part
        for (let i = 0; i < part.length; i++) positions.push(offset)
        offset += c.length
      }
      for (const term of terms) {
        if (term.field && term.field !== field) continue
        const candidates = [{ value: term.value, exact: term.exact }, ...plan.info.corrections.filter((c) => c.from === term.value).map((c) => ({ value: c.to, exact: true }))]
        for (const candidate of candidates) {
          const pattern = searchWords(candidate.value).join('[^\\p{L}\\p{N}]+')
          const found = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}${candidate.exact ? '(?![\\p{L}\\p{N}])' : ''}`, 'u').exec(folded)
          if (!found) continue
          const start = positions[found.index] ?? 0
          const end = positions[found.index + found[0].length] ?? text.length
          const lineStart = text.lastIndexOf('\n', start - 1) + 1
          const nextLine = text.indexOf('\n', end)
          const lineEnd = nextLine < 0 ? text.length : nextLine
          const left = Math.max(lineStart, start - 35)
          const right = Math.min(lineEnd, Math.max(end + 65, left + 110))
          const prefix = left > lineStart ? '…' : ''
          return { field, text: prefix + text.slice(left, right) + (right < lineEnd ? '…' : ''), ranges: [[start - left + prefix.length, end - left + prefix.length]] }
        }
      }
    }
    return undefined
  }
}

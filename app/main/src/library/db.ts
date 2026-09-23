import { t } from '../i18n'
import { mkdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { isAxisId, type AxisId } from '@shared/axes'
import { movePlaylistItems, type PlaylistMove } from '@shared/playlist'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, type GeneratedScriptRow } from '@shared/ipc'
import {
  SECTIONS,
  titleStartsWith,
  type FolderNode,
  type GridEntry,
  type LibraryCounts,
  type LibraryRoot,
  type MediaIndexRow,
  type MediaPage,
  type MediaQuery,
  type MediaRow,
  type MediaScript,
  type Playlist,
  type PlaylistEntry,
  type Section,
  type Sort,
  type Tag,
} from '@shared/library'
import { PROJECTION_KINDS, type ProjectionKind } from '@shared/projection'
import { ROOT_KINDS, type RootKind } from '@shared/remote'
import { holdBack, mixRecommended, recommendSeed, type MixEntry } from './recommend'
import { SEARCH_SCHEMA, SearchIndex, type CompiledSearch } from './search-index'
import { normalizeSearch, type ImportedPerformer, type Performer } from '@shared/search'
import { sessionRun, sessionSetup } from '@shared/session-settings'
import type { SavedSession, SessionHistory, SessionRun, SessionSetup } from '@shared/session'
import type { EditorFilePage, EditorFileQuery } from '@shared/editor'

type Row = Record<string, SQLOutputValue>

const num = (row: Row, key: string): number => {
  const v = row[key]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0
}
const numOrNull = (row: Row, key: string): number | null => {
  const v = row[key]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}
const text = (row: Row, key: string): string => {
  const v = row[key]
  return typeof v === 'string' ? v : ''
}
const numbers = (json: string): number[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}
const strings = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

const SCHEMA_V1 = `
CREATE TABLE roots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  sessions INTEGER NOT NULL DEFAULT 1,
  last_scan INTEGER
);
CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  codec TEXT NOT NULL DEFAULT '',
  projection TEXT NOT NULL DEFAULT 'flat',
  hash TEXT,
  thumb_ready INTEGER NOT NULL DEFAULT 0,
  strip_ready INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,
  axes TEXT NOT NULL DEFAULT '[]',
  average_speed REAL NOT NULL DEFAULT 0,
  heat TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX media_root_folder ON media(root_id, folder);
CREATE INDEX media_mtime ON media(mtime);
CREATE TABLE scripts (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  axis TEXT NOT NULL,
  source TEXT NOT NULL,
  container TEXT NOT NULL,
  actions INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  average_speed REAL NOT NULL,
  max_speed REAL NOT NULL,
  heatmap TEXT NOT NULL,
  PRIMARY KEY (media_id, axis)
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE media_tags (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
);
CREATE TABLE watch (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  position_ms INTEGER,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER
);
CREATE INDEX watch_last_played ON watch(last_played);
`

const SCHEMA_V2 = `
ALTER TABLE media ADD COLUMN scripts_stamp TEXT NOT NULL DEFAULT '';
CREATE INDEX media_added_at ON media(added_at);
CREATE INDEX media_title ON media(title COLLATE NOCASE);
CREATE INDEX playlist_items_media ON playlist_items(media_id);
`

const SCHEMA_V3 = `
CREATE TABLE video_settings (
  key TEXT PRIMARY KEY,
  position_ms INTEGER,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

const SCHEMA_V4 = `
ALTER TABLE media ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE TABLE excluded_folders (
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  PRIMARY KEY (root_id, folder)
);
`

const SCHEMA_V5 = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  planned_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_items (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);
CREATE INDEX session_items_media ON session_items(media_id);
`

const SCHEMA_V6 = `
ALTER TABLE media ADD COLUMN title_set INTEGER NOT NULL DEFAULT 0;
`

const SCHEMA_V8 = `
ALTER TABLE media ADD COLUMN tags_ready INTEGER NOT NULL DEFAULT 0;
`

const SCHEMA_V9 = `
ALTER TABLE media ADD COLUMN cover_stamp TEXT NOT NULL DEFAULT '';
`

const SCHEMA_V10 = `
CREATE INDEX media_tags_tag ON media_tags(tag_id);
`

const SCHEMA_V11 = `
CREATE TABLE generated (
  key TEXT NOT NULL,
  axis TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  stamp TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, axis)
);
`

const SCHEMA_V12 = `
ALTER TABLE roots ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE roots ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE roots ADD COLUMN username TEXT NOT NULL DEFAULT '';
ALTER TABLE roots ADD COLUMN secret TEXT NOT NULL DEFAULT '';
ALTER TABLE roots ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN remote_key TEXT NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN remote_stamp TEXT NOT NULL DEFAULT '';
`

const SCHEMA_V13 = `
CREATE TABLE editor_docs (
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, kind)
);
CREATE TABLE editor_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  points TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE editor_exports (
  at INTEGER NOT NULL
);
`

const SCHEMA_V14 = `
CREATE TABLE remote_writes (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT ''
);
`

const SCHEMA_V16 = `
ALTER TABLE media ADD COLUMN strip_stamp TEXT NOT NULL DEFAULT '';
CREATE TABLE remote_assets (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (media_id, kind)
);
CREATE TABLE imported_groups (
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (root_id, group_id)
);
`

const SCHEMA_V17 = `
ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT 'Session';
ALTER TABLE sessions ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sessions ADD COLUMN run_json TEXT;
CREATE TABLE saved_sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  favourite INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  setup_json TEXT NOT NULL
);
`

export const FOLDED_STAMP = 'folded'

const SCHEMA_V18 = `
ALTER TABLE media ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
UPDATE media SET favourite = 1 WHERE rating >= 4;
UPDATE media SET remote_stamp = '${FOLDED_STAMP}' WHERE root_id IN (SELECT id FROM roots WHERE kind = 'heresphere');
`

const SCHEMA_VERSION = 19

const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined

function migrate(db: DatabaseSync) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = row ? num(row, 'user_version') : 0
  if (version >= SCHEMA_VERSION) return
  db.exec('BEGIN')
  try {
    switch (version) {
      case 0:
        db.exec(SCHEMA_V1)
      case 1:
        db.exec(SCHEMA_V2)
      case 2:
        db.exec(SCHEMA_V3)
      case 3:
        db.exec(SCHEMA_V4)
      case 4:
        db.exec(SCHEMA_V5)
      case 5:
      case 6:
        if (!hasColumn(db, 'media', 'title_set')) db.exec(SCHEMA_V6)
      case 7:
        db.exec(SCHEMA_V8)
      case 8:
        db.exec(SCHEMA_V9)
      case 9:
        db.exec(SCHEMA_V10)
      case 10:
        db.exec(SCHEMA_V11)
      case 11:
        db.exec(SCHEMA_V12)
      case 12:
        db.exec(SCHEMA_V13)
      case 13:
        db.exec(SCHEMA_V14)
      case 14:
        db.exec(SEARCH_SCHEMA)
      case 15:
        db.exec(SCHEMA_V16)
      case 16:
        db.exec(SCHEMA_V17)
      case 17:
        db.exec(SCHEMA_V18)
      case 18:
        if (!hasColumn(db, 'media', 'thumb_quality')) db.exec('ALTER TABLE media ADD COLUMN thumb_quality INTEGER NOT NULL DEFAULT 0')
        if (!hasColumn(db, 'media', 'strip_quality')) db.exec('ALTER TABLE media ADD COLUMN strip_quality INTEGER NOT NULL DEFAULT 0')
      default:
        break
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface MediaUpsert {
  rootId: number
  path: string
  folder: string
  title: string
  size: number
  mtime: number
  durationMs: number
  width: number
  height: number
  codec: string
  projection: ProjectionKind
  remoteKey?: string
}

export interface ServerRoot {
  id: number
  kind: Exclude<RootKind, 'folder'>
  url: string
  username: string
  secret: string
}

export type ThumbState = 'pending' | 'ready' | 'failed'
export interface TagRow {
  id: number
  rootId: number
  path: string
  durationMs: number
}
export type ThumbKind = 'thumb' | 'strip' | 'tags'
const READY_COLUMN: Record<ThumbKind, string> = { thumb: 'thumb_ready', strip: 'strip_ready', tags: 'tags_ready' }

const thumbState = (n: number): ThumbState => (n === 1 ? 'ready' : n === 2 ? 'failed' : 'pending')
const THUMB_CODE: Record<ThumbState, number> = { pending: 0, ready: 1, failed: 2 }

export interface MediaStamp {
  id: number
  size: number
  mtime: number
  durationMs: number
  thumb: ThumbState
  strip: ThumbState
  tags: ThumbState
  scriptsStamp: string
  coverStamp: string
  remoteStamp: string
}

export interface MatchMedia {
  id: number
  rootId: number
  path: string
  stem: string
  title: string
  folder: string
  durationMs: number
  mtime: number
  axes: AxisId[]
}

export interface ScriptRow extends MediaScript {
  heatmap: number[]
}

export type ScriptKey = Pick<ScriptRow, 'axis' | 'source' | 'actions' | 'durationMs'>

export interface ScriptSummary {
  axes: AxisId[]
  averageSpeed: number
  heat: number[]
}

export interface VideoSettingsRow {
  positionMs: number | null
  settings: string
}

export type EditorDocKind = 'saved' | 'draft' | 'exported'

export interface GeneratedRows {
  hash: string
  stamp: string
  scripts: GeneratedScriptRow[]
}

const MEDIA_FROM = 'FROM media m LEFT JOIN watch w ON w.media_id = m.id LEFT JOIN video_settings v ON v.key = m.path'

const ROW_COLUMNS = `m.*, v.position_ms, w.play_count, w.last_played,
  (SELECT json_group_array(name) FROM (SELECT t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id ORDER BY t.name)) AS tag_names`
const ROW_SELECT = `SELECT ${ROW_COLUMNS} ${MEDIA_FROM}`

const CONTINUE_HOLD = 16

const SORT_SQL: Record<Exclude<Sort, 'recommended'>, string> = {
  added: 'm.added_at',
  name: 'm.title COLLATE NOCASE',
  modified: 'm.mtime',
  duration: 'm.duration_ms',
  speed: 'm.average_speed',
  rating: 'm.rating',
  lastPlayed: 'w.last_played',
  plays: 'coalesce(w.play_count, 0)',
}

const CONTINUE_SQL = 'v.position_ms IS NOT NULL AND v.position_ms > 0 AND v.position_ms < m.duration_ms - 5000'
const SHOWN_SQL = 'm.hidden = 0'

const tagName = (tag: string) => tag.trim().toLowerCase()
const HAS_SCRIPTS_SQL = 'EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id)'
const HAS_AXES_SQL = (axes: string) => `EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis IN (${axes}))`

const SECTION_SQL: Partial<Record<Section, string>> = {
  favourites: 'm.favourite = 1',
  unscripted: `NOT ${HAS_SCRIPTS_SQL}`,
  mostWatched: 'coalesce(w.play_count, 0) > 0',
  multiAxis: '(SELECT count(*) FROM scripts s WHERE s.media_id = m.id) >= 2',
  singleAxis: '(SELECT count(*) FROM scripts s WHERE s.media_id = m.id) = 1',
  sr6: HAS_AXES_SQL(`'L1', 'L2'`),
  osr2: HAS_AXES_SQL(`'R1', 'R2'`),
  twist: HAS_AXES_SQL(`'R0'`),
  estim: HAS_AXES_SQL(`'EA', 'EB', 'EV'`),
  focstim: HAS_AXES_SQL(`'E1', 'E2', 'E3', 'E4'`),
  restim: HAS_AXES_SQL(`'EA', 'EB'`),
  vr: "m.projection != 'flat'",
  '2d': "m.projection = 'flat'",
  res1080: 'm.height >= 1080',
  res1440: 'm.height >= 1440',
  res4k: 'm.height >= 2160',
  len0to2: 'm.duration_ms < 120000',
  len2to5: 'm.duration_ms >= 120000 AND m.duration_ms < 300000',
  len5to15: 'm.duration_ms >= 300000 AND m.duration_ms < 900000',
  len15to30: 'm.duration_ms >= 900000 AND m.duration_ms < 1800000',
  len30plus: 'm.duration_ms >= 1800000',
}

function folderWhere(folder: NonNullable<MediaQuery['folder']>, params: SQLInputValue[]): string[] {
  const where = ['m.root_id = ?']
  params.push(folder.rootId)
  if (folder.folder) {
    where.push("(m.folder = ? OR (m.folder > ? || '/' AND m.folder < ? || '0'))")
    params.push(folder.folder, folder.folder, folder.folder)
  }
  return where
}

export class LibraryDb {
  private readonly db: DatabaseSync
  private readonly searchIndex: SearchIndex
  private readonly cache = new Map<string, StatementSync>()
  private txDepth = 0

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    migrate(this.db)
    this.db.exec("UPDATE sessions SET status = 'interrupted' WHERE status = 'running'")
    this.searchIndex = new SearchIndex(this.db)
  }

  close() {
    this.searchIndex.close()
    this.db.close()
  }

  prepareSearch(): Promise<void> {
    return this.searchIndex.ready()
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      if (this.cache.size >= 160) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(sql, s)
    }
    return s
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++
      try {
        return fn()
      } finally {
        this.txDepth--
      }
    }
    this.db.exec('BEGIN')
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.txDepth = 0
    }
  }

  roots(): LibraryRoot[] {
    return this.stmt('SELECT * FROM roots ORDER BY id').all().map(toRoot)
  }

  root(id: number): LibraryRoot | null {
    const row = this.stmt('SELECT * FROM roots WHERE id = ?').get(id)
    return row ? toRoot(row) : null
  }

  addRoot(path: string): LibraryRoot {
    this.stmt('INSERT OR IGNORE INTO roots (path) VALUES (?)').run(path)
    const row = this.stmt('SELECT * FROM roots WHERE path = ?').get(path)
    if (!row) throw new Error(`root not stored: ${path}`)
    return toRoot(row)
  }

  addServer(server: Omit<ServerRoot, 'id'> & { name: string }): LibraryRoot {
    this.stmt(
      `INSERT INTO roots (path, kind, name, username, secret) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, name = excluded.name, username = excluded.username, secret = excluded.secret, error = ''`,
    ).run(server.url, server.kind, server.name, server.username, server.secret)
    const row = this.stmt('SELECT * FROM roots WHERE path = ?').get(server.url)
    if (!row) throw new Error(`root not stored: ${server.url}`)
    return toRoot(row)
  }

  server(id: number): ServerRoot | null {
    const row = this.stmt('SELECT * FROM roots WHERE id = ?').get(id)
    if (!row) return null
    const kind = text(row, 'kind')
    if (kind !== 'stash' && kind !== 'heresphere') return null
    return { id, kind, url: text(row, 'path'), username: text(row, 'username'), secret: text(row, 'secret') }
  }

  servers(): ServerRoot[] {
    return this.stmt("SELECT id FROM roots WHERE kind != 'folder' ORDER BY id")
      .all()
      .map((r) => this.server(num(r, 'id')))
      .filter((s): s is ServerRoot => s !== null)
  }

  setRootError(id: number, error: string) {
    this.stmt('UPDATE roots SET error = ? WHERE id = ?').run(error, id)
  }

  removeRoot(id: number) {
    this.stmt('DELETE FROM roots WHERE id = ?').run(id)
  }

  setRootSessions(id: number, sessions: boolean) {
    this.stmt('UPDATE roots SET sessions = ? WHERE id = ?').run(sessions ? 1 : 0, id)
  }

  setRootScanned(id: number, at: number) {
    this.stmt('UPDATE roots SET last_scan = ? WHERE id = ?').run(at, id)
  }

  stamp(path: string): MediaStamp | null {
    const row = this.stmt('SELECT id, size, mtime, duration_ms, thumb_ready, strip_ready, thumb_quality, strip_quality, remote_key, tags_ready, scripts_stamp, cover_stamp, remote_stamp FROM media WHERE path = ?').get(path)
    if (!row) return null
    return {
      id: num(row, 'id'),
      size: num(row, 'size'),
      mtime: num(row, 'mtime'),
      durationMs: num(row, 'duration_ms'),
      thumb: text(row, 'remote_key') === '' && num(row, 'thumb_quality') === 0 && num(row, 'thumb_ready') === 1 ? 'pending' : thumbState(num(row, 'thumb_ready')),
      strip: text(row, 'remote_key') === '' && num(row, 'strip_quality') === 0 && num(row, 'strip_ready') === 1 ? 'pending' : thumbState(num(row, 'strip_ready')),
      tags: thumbState(num(row, 'tags_ready')),
      scriptsStamp: text(row, 'scripts_stamp'),
      coverStamp: text(row, 'cover_stamp'),
      remoteStamp: text(row, 'remote_stamp'),
    }
  }

  upsertMedia(m: MediaUpsert, now: number): number {
    const row = this.stmt(
      `INSERT INTO media (root_id, path, folder, title, size, mtime, added_at, duration_ms, width, height, codec, projection, remote_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET root_id = excluded.root_id, folder = excluded.folder, title = CASE WHEN title_set THEN title ELSE excluded.title END,
         size = excluded.size, mtime = excluded.mtime, duration_ms = excluded.duration_ms, width = excluded.width,
         height = excluded.height, codec = excluded.codec, projection = excluded.projection, remote_key = excluded.remote_key,
         thumb_ready = 0, strip_ready = 0, tags_ready = 0
       RETURNING id`,
    ).get(m.rootId, m.path, m.folder, m.title, m.size, m.mtime, now, m.durationMs, m.width, m.height, m.codec, m.projection, m.remoteKey ?? '')
    return row ? num(row, 'id') : 0
  }

  setAddedAt(id: number, addedAt: number) {
    this.stmt('UPDATE media SET added_at = ? WHERE id = ?').run(addedAt, id)
  }

  setRemoteStamp(id: number, stamp: string) {
    this.stmt('UPDATE media SET remote_stamp = ? WHERE id = ?').run(stamp, id)
  }

  metadata(id: number): { description: string; studio: string; performers: Performer[] } {
    const row = this.stmt('SELECT description, studio FROM media_details WHERE media_id = ?').get(id)
    const performers = this.stmt('SELECT p.* FROM media_performers mp JOIN performers p ON p.id = mp.performer_id WHERE mp.media_id = ? ORDER BY p.name, p.id').all(id)
      .map((p) => ({ id: num(p, 'id'), name: text(p, 'name'), aliases: strings(text(p, 'aliases')) }))
    return { description: row ? text(row, 'description') : '', studio: row ? text(row, 'studio') : '', performers }
  }

  setMetadata(id: number, data: { description: string; studio: string; filename: string; performers: ImportedPerformer[] }) {
    const media = this.stmt('SELECT root_id FROM media WHERE id = ?').get(id)
    if (!media) return
    const root = num(media, 'root_id')
    this.transaction(() => {
      this.stmt(`INSERT INTO media_details(media_id, description, studio, filename, import_version) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(media_id) DO UPDATE SET description = excluded.description, studio = excluded.studio, filename = excluded.filename, import_version = 1`)
        .run(id, data.description, data.studio, data.filename)
      this.stmt('DELETE FROM media_performers WHERE media_id = ?').run(id)
      for (const person of data.performers) {
        const name = person.name.trim()
        if (!name) continue
        const key = person.key || `name:${normalizeSearch(name)}`
        const aliases = JSON.stringify([...new Set(person.aliases.map((a) => a.trim()).filter(Boolean))])
        const row = this.stmt(`INSERT INTO performers(root_id, source_key, name, aliases) VALUES (?, ?, ?, ?)
          ON CONFLICT(root_id, source_key) DO UPDATE SET name = excluded.name, aliases = excluded.aliases
          WHERE name != excluded.name OR aliases != excluded.aliases RETURNING id`).get(root, key, name, aliases)
          ?? this.stmt('SELECT id FROM performers WHERE root_id = ? AND source_key = ?').get(root, key)
        if (row) this.stmt('INSERT OR IGNORE INTO media_performers(media_id, performer_id) VALUES (?, ?)').run(id, num(row, 'id'))
      }
    })
  }

  metadataImported(id: number): boolean {
    return this.stmt('SELECT 1 FROM media_details WHERE media_id = ? AND import_version = 1').get(id) !== undefined
  }

  remoteKey(id: number): { rootId: number; key: string } | null {
    const row = this.stmt("SELECT root_id, remote_key FROM media WHERE id = ? AND remote_key != ''").get(id)
    return row ? { rootId: num(row, 'root_id'), key: text(row, 'remote_key') } : null
  }

  queueRemoteWrite(id: number) {
    this.stmt(`INSERT INTO remote_writes (media_id) SELECT id FROM media WHERE id = ? AND remote_key != ''
      ON CONFLICT(media_id) DO UPDATE SET revision = revision + 1`).run(id)
  }

  remoteRowIds(): number[] {
    return this.stmt("SELECT id FROM media WHERE remote_key != ''").all().map((r) => num(r, 'id'))
  }

  hasRemoteWrite(id: number): boolean {
    return this.stmt('SELECT 1 FROM remote_writes WHERE media_id = ?').get(id) !== undefined
  }

  remoteWrites(): { id: number; revision: number }[] {
    return this.stmt('SELECT media_id, revision FROM remote_writes ORDER BY media_id').all()
      .map((r) => ({ id: num(r, 'media_id'), revision: num(r, 'revision') }))
  }

  finishRemoteWrite(id: number, revision: number) {
    this.stmt('DELETE FROM remote_writes WHERE media_id = ? AND revision = ?').run(id, revision)
  }

  failRemoteWrite(id: number, revision: number, error: string) {
    this.stmt('UPDATE remote_writes SET error = ? WHERE media_id = ? AND revision = ?').run(error, id, revision)
  }

  remoteWriteError(rootId: number): string {
    const row = this.stmt(`SELECT w.error FROM remote_writes w JOIN media m ON m.id = w.media_id
      WHERE m.root_id = ? AND w.error != '' ORDER BY w.media_id LIMIT 1`).get(rootId)
    return row ? text(row, 'error') : ''
  }

  remoteMediaIdsWithTag(tag: string): number[] {
    return this.stmt("SELECT m.id FROM media m JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id WHERE t.name = ? AND m.remote_key != ''")
      .all(tagName(tag))
      .map((r) => num(r, 'id'))
  }

  mediaIds(rootId: number): { id: number; path: string }[] {
    return this.stmt('SELECT id, path FROM media WHERE root_id = ?')
      .all(rootId)
      .map((r) => ({ id: num(r, 'id'), path: text(r, 'path') }))
  }

  allMediaIds(): number[] {
    return this.stmt('SELECT id FROM media').all().map((r) => num(r, 'id'))
  }

  remoteRows(rootId: number): { id: number; key: string; path: string; stamp: string }[] {
    return this.stmt('SELECT id, remote_key, path, remote_stamp FROM media WHERE root_id = ?')
      .all(rootId)
      .map((r) => ({ id: num(r, 'id'), key: text(r, 'remote_key'), path: text(r, 'path'), stamp: text(r, 'remote_stamp') }))
  }

  mediaForMatching(): MatchMedia[] {
    return this.stmt("SELECT id, root_id, path, title, folder, duration_ms, mtime, axes FROM media WHERE hidden = 0 AND remote_key = ''")
      .all()
      .map((r) => {
        const path = text(r, 'path')
        return {
          id: num(r, 'id'),
          rootId: num(r, 'root_id'),
          path,
          stem: basename(path, extname(path)),
          title: text(r, 'title'),
          folder: text(r, 'folder'),
          durationMs: num(r, 'duration_ms'),
          mtime: num(r, 'mtime'),
          axes: strings(text(r, 'axes')).filter(isAxisId),
        }
      })
  }

  removeMedia(ids: number[]) {
    if (ids.length === 0) return
    this.transaction(() => {
      const del = this.stmt('DELETE FROM media WHERE id = ?')
      for (const id of ids) del.run(id)
    })
  }

  setThumbState(id: number, kind: ThumbKind, state: ThumbState) {
    const quality = kind !== 'tags' && state === 'ready' ? `, ${kind}_quality = 1` : ''
    this.stmt(`UPDATE media SET ${READY_COLUMN[kind]} = ?${quality} WHERE id = ?`).run(THUMB_CODE[state], id)
  }

  resetTags(servers = false): TagRow[] {
    const scope = servers ? '' : "AND remote_key = ''"
    return this.transaction(() => {
      this.stmt(`UPDATE media SET tags_ready = 0 WHERE duration_ms > 0 ${scope}`).run()
      return this.tagRows(`duration_ms > 0 ${scope}`)
    })
  }

  setServerTagging(on: boolean): TagRow[] {
    return this.transaction(() => {
      if (!on) {
        this.stmt("UPDATE media SET tags_ready = 2 WHERE remote_key != '' AND tags_ready = 0").run()
        return []
      }
      this.stmt("UPDATE media SET tags_ready = 0 WHERE remote_key != '' AND tags_ready != 1 AND duration_ms > 0").run()
      return this.tagRows("remote_key != '' AND tags_ready = 0")
    })
  }

  private tagRows(where: string): TagRow[] {
    return this.stmt(`SELECT id, root_id, path, duration_ms FROM media WHERE ${where} ORDER BY id`)
      .all()
      .map((r) => ({ id: num(r, 'id'), rootId: num(r, 'root_id'), path: text(r, 'path'), durationMs: num(r, 'duration_ms') }))
  }

  setRating(id: number, rating: number) {
    this.stmt('UPDATE media SET rating = ? WHERE id = ?').run(rating, id)
  }

  setTitle(id: number, title: string) {
    const name = title.trim()
    this.rec = null
    if (name) this.stmt('UPDATE media SET title = ?, title_set = 1 WHERE id = ?').run(name, id)
    else {
      const row = this.stmt('SELECT path FROM media WHERE id = ?').get(id)
      if (row) this.stmt('UPDATE media SET title = ?, title_set = 0 WHERE id = ?').run(basename(text(row, 'path'), extname(text(row, 'path'))), id)
    }
  }

  setPinned(ids: number[], pinnedAt: number) {
    this.each(ids, 'UPDATE media SET pinned = ? WHERE id = ?', pinnedAt)
  }

  setHidden(ids: number[], hidden: boolean) {
    this.each(ids, 'UPDATE media SET hidden = ? WHERE id = ?', hidden ? 1 : 0)
  }

  setFavourite(ids: number[], favourite: boolean) {
    this.each(ids, 'UPDATE media SET favourite = ? WHERE id = ?', favourite ? 1 : 0)
  }

  private each(ids: number[], sql: string, ...value: SQLInputValue[]) {
    if (ids.length === 0) return
    this.transaction(() => {
      const write = this.stmt(sql)
      for (const id of ids) write.run(...value, id)
    })
  }

  location(id: number): { rootId: number; path: string; folder: string } | null {
    const row = this.stmt('SELECT root_id, path, folder FROM media WHERE id = ?').get(id)
    return row
      ? {
          rootId: num(row, 'root_id'),
          path: text(row, 'path'),
          folder: text(row, 'folder'),
        }
      : null
  }

  moveMedia(id: number, to: { rootId: number; path: string; folder: string }, oldPath: string) {
    this.transaction(() => {
      this.stmt('UPDATE media SET root_id = ?, path = ?, folder = ? WHERE id = ?').run(to.rootId, to.path, to.folder, id)
      const oldDir = dirname(oldPath)
      const newDir = dirname(to.path)
      const update = this.stmt('UPDATE scripts SET source = ? WHERE media_id = ? AND axis = ?')
      for (const row of this.stmt("SELECT axis, source FROM scripts WHERE media_id = ? AND container = 'sibling'").all(id)) {
        const source = text(row, 'source')
        if (dirname(source) === oldDir) update.run(join(newDir, basename(source)), id, text(row, 'axis'))
      }
      this.stmt('DELETE FROM video_settings WHERE key = ?').run(to.path)
      this.stmt('UPDATE video_settings SET key = ? WHERE key = ?').run(to.path, oldPath)
      this.stmt('DELETE FROM generated WHERE key = ?').run(to.path)
      this.stmt('UPDATE generated SET key = ? WHERE key = ?').run(to.path, oldPath)
      this.stmt('DELETE FROM editor_docs WHERE key = ?').run(to.path)
      this.stmt('UPDATE editor_docs SET key = ? WHERE key = ?').run(to.path, oldPath)
    })
  }

  mediaRow(id: number): MediaRow | null {
    const row = this.stmt(`${ROW_SELECT} WHERE m.id = ?`).get(id)
    return row ? toMediaRow(row) : null
  }

  mediaRowByPath(path: string): MediaRow | null {
    const row = this.stmt(`${ROW_SELECT} WHERE m.path = ?`).get(path)
    return row ? toMediaRow(row) : null
  }

  mediaRowByTitle(title: string): MediaRow | null {
    const row = this.stmt(`${ROW_SELECT} WHERE m.title = ? ORDER BY (m.axes != '[]') DESC, m.id LIMIT 1`).get(title)
    return row ? toMediaRow(row) : null
  }

  scripts(mediaId: number): ScriptRow[] {
    return this.stmt('SELECT * FROM scripts WHERE media_id = ? ORDER BY rowid').all(mediaId).map(toScript)
  }

  scriptKeys(mediaId: number): ScriptKey[] {
    return this.stmt('SELECT axis, source, actions, duration_ms FROM scripts WHERE media_id = ? ORDER BY rowid')
      .all(mediaId)
      .map((row) => {
        const axis = text(row, 'axis')
        return { axis: isAxisId(axis) ? axis : 'L0', source: text(row, 'source'), actions: num(row, 'actions'), durationMs: num(row, 'duration_ms') }
      })
  }

  setScriptsStamp(mediaId: number, stamp: string) {
    this.stmt('UPDATE media SET scripts_stamp = ? WHERE id = ?').run(stamp, mediaId)
  }

  setCoverStamp(mediaId: number, stamp: string) {
    const result = this.stmt('UPDATE media SET cover_stamp = ?, thumb_ready = 0 WHERE id = ? AND cover_stamp != ?').run(stamp, mediaId, stamp)
    if (result.changes) this.rec = null
  }

  setScripts(mediaId: number, scripts: ScriptRow[], summary: ScriptSummary) {
    this.transaction(() => {
      this.stmt('DELETE FROM scripts WHERE media_id = ?').run(mediaId)
      const insert = this.stmt('INSERT OR REPLACE INTO scripts (media_id, axis, source, container, actions, duration_ms, average_speed, max_speed, heatmap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const s of scripts) {
        insert.run(mediaId, s.axis, s.source, s.container, s.actions, s.durationMs, s.averageSpeed, s.maxSpeed, JSON.stringify(s.heatmap))
      }
      this.stmt('UPDATE media SET axes = ?, average_speed = ?, heat = ? WHERE id = ?').run(JSON.stringify(summary.axes), summary.averageSpeed, JSON.stringify(summary.heat), mediaId)
    })
  }

  query(q: MediaQuery): MediaPage {
    if (q.sort === 'recommended' && q.playlistId === undefined && !q.search?.trim()) return this.queryRecommended(q)
    const { withSql, join, whereSql, orderSql, params, search } = this.compile(q)
    const total = q.offset > 0 ? null : this.stmt(`${withSql}SELECT count(*) AS n ${MEDIA_FROM}${join}${whereSql}`).get(...params)
    const columns = ROW_COLUMNS + (q.playlistId === undefined ? '' : ', pi.position AS playlist_position')
    const rows = this.stmt(`${withSql}SELECT ${columns} ${MEDIA_FROM}${join}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset)
    return {
      rows: rows.map((row) => {
        const media = toMediaRow(row)
        if (search) {
          media.searchMatch = this.searchIndex.match(media.id, search.plan) ?? null
          media.performers = this.metadata(media.id).performers
        }
        return media
      }),
      total: q.offset > 0 ? null : total ? num(total, 'n') : 0,
      ...(search ? { search: search.plan.info, rev: this.searchIndex.revision() } : {}),
    }
  }

  queryIds(q: MediaQuery): number[] {
    if (q.sort === 'recommended' && q.playlistId === undefined && !q.search?.trim()) return this.recommended(q).entries.flatMap((e) => (e.kind === 'video' ? [e.id] : []))
    const { withSql, join, whereSql, orderSql, params } = this.compile(q)
    return this.stmt(`${withSql}SELECT m.id ${MEDIA_FROM}${join}${whereSql} ORDER BY ${orderSql}`)
      .all(...params)
      .map((r) => num(r, 'id'))
  }

  jump(q: MediaQuery, prefix: string): { index: number; id: number } | null {
    if (q.sort === 'recommended' && q.playlistId === undefined && !q.search?.trim()) {
      const rec = this.recommended(q)
      for (let i = 0; i < rec.entries.length; i++) {
        const e = rec.entries[i]!
        if (e.kind === 'video' && titleStartsWith(rec.titles.get(e.id) ?? '', prefix)) return { index: i, id: e.id }
      }
      return null
    }
    const { withSql, join, whereSql, orderSql, params } = this.compile(q)
    const rows = this.stmt(`${withSql}SELECT m.id, m.title ${MEDIA_FROM}${join}${whereSql} ORDER BY ${orderSql}`).all(...params)
    const index = rows.findIndex((r) => titleStartsWith(text(r, 'title'), prefix))
    return index === -1 ? null : { index, id: num(rows[index]!, 'id') }
  }

  private queryRecommended(q: MediaQuery): MediaPage {
    const rec = this.recommended(q)
    const slice = rec.entries.slice(q.offset, q.offset + q.limit)
    const ids = slice.flatMap((e) => (e.kind === 'video' ? [e.id] : []))
    const byId = new Map<number, MediaRow>()
    if (ids.length > 0) {
      const marks = ids.map(() => '?').join(',')
      for (const row of this.stmt(`${ROW_SELECT} WHERE m.id IN (${marks})`).all(...ids)) {
        const media = toMediaRow(row)
        byId.set(media.id, media)
      }
    }
    const rows = slice.flatMap((e): GridEntry[] => {
      if (e.kind === 'playlist') {
        const entry = rec.playlists.get(e.id)
        return entry ? [entry] : []
      }
      const media = byId.get(e.id)
      return media ? [media] : []
    })
    return { rows, total: q.offset > 0 ? null : rec.videos, rev: rec.rev }
  }

  private rec: {
    key: string
    sig: string
    rev: number
    entries: MixEntry[]
    videos: number
    playlists: Map<number, PlaylistEntry>
    titles: Map<number, string>
  } | null = null
  private recRev = 0

  private recommended(q: MediaQuery) {
    const { join, whereSql, params } = this.compile(q)
    const now = new Date()
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const held = new Set<number>()
    if (q.continueRow) {
      const c = this.compile({ ...q, section: 'continue', sort: 'lastPlayed', desc: true })
      for (const r of this.stmt(`SELECT m.id ${MEDIA_FROM}${c.join}${c.whereSql} ORDER BY ${c.orderSql} LIMIT 4`).all(...c.params)) held.add(num(r, 'id'))
    }
    const key = `${day}|${JSON.stringify({ ...q, limit: 0, offset: 0, desc: true })}|${[...held].join(',')}`
    const sigRow = this.stmt(
      `SELECT count(*) n, coalesce(sum(m.id),0) ids, coalesce(sum(m.pinned),0) pins, coalesce(sum(w.play_count),0) plays,
        coalesce(max(w.last_played),0) recent, coalesce(max(m.added_at),0) added
       ${MEDIA_FROM}${join}${whereSql}`,
    ).get(...params)
    const sig =
      `${num(sigRow!, 'n')}:${num(sigRow!, 'ids')}:${num(sigRow!, 'pins')}:${num(sigRow!, 'plays')}:${num(sigRow!, 'recent')}:${num(sigRow!, 'added')}|` +
      text(
        this.stmt(
          `SELECT (SELECT count(*) FROM playlists) || ':' || (SELECT coalesce(sum(c),0) FROM (SELECT count(*) c FROM playlist_items GROUP BY playlist_id))
             || ':' || (SELECT coalesce(max(id),0) FROM playlists)
             || ':' || (SELECT coalesce(sum(m.thumb_ready * m.id),0) FROM playlist_items pi JOIN media m ON m.id = pi.media_id)
             || ':' || (SELECT coalesce(sum(m.thumb_quality * m.id),0) FROM playlist_items pi JOIN media m ON m.id = pi.media_id) s`,
        ).get()!,
        's',
      )
    if (this.rec?.key === key && this.rec.sig === sig) return this.rec

    const rows = this.stmt(`SELECT m.id, m.title, m.pinned, m.added_at, coalesce(w.play_count, 0) pc, w.last_played lp ${MEDIA_FROM}${join}${whereSql}`).all(...params)
    const pinned: MixEntry[] = rows
      .filter((r) => num(r, 'pinned') > 0)
      .sort((a, b) => num(b, 'pinned') - num(a, 'pinned') || num(a, 'id') - num(b, 'id'))
      .map((r) => ({ kind: 'video', id: num(r, 'id') }))
    const rest = rows.filter((r) => num(r, 'pinned') === 0)

    const pls = this.stmt(`SELECT p.id, p.name, count(pi.media_id) cnt FROM playlists p JOIN playlist_items pi ON pi.playlist_id = p.id GROUP BY p.id ORDER BY cnt DESC, p.id`).all()
    const thumbs = new Map<number, string[]>()
    for (const r of this.stmt(`SELECT pi.playlist_id pid, m.id mid, m.mtime mt, m.cover_stamp cs, m.thumb_quality tq FROM playlist_items pi JOIN media m ON m.id = pi.media_id WHERE m.thumb_ready = 1 ORDER BY pi.playlist_id, pi.position`).all()) {
      const pid = num(r, 'pid')
      const list = thumbs.get(pid) ?? []
      if (list.length < 4) {
        list.push(`thumb://media/${num(r, 'mid')}?v=${num(r, 'mt')}${coverKey(text(r, 'cs'))}&q=${num(r, 'tq')}`)
        thumbs.set(pid, list)
      }
    }

    const seed = recommendSeed(day, rows.map((r) => num(r, 'id')))
    const sprinkle = q.section === 'all' && !q.folder && !q.search?.trim() && Object.values(q.filters).every((v) => v === undefined)
    const mix = mixRecommended(
      rest.map((r) => ({ id: num(r, 'id'), playCount: num(r, 'pc'), lastPlayed: numOrNull(r, 'lp'), addedAt: num(r, 'added_at') })),
      sprinkle ? pls.map((r) => ({ id: num(r, 'id'), count: num(r, 'cnt') })) : [],
      seed,
    )
    this.rec = {
      key,
      sig,
      rev: ++this.recRev,
      entries: holdBack([...pinned, ...mix], held, CONTINUE_HOLD),
      videos: rows.length,
      playlists: new Map(pls.map((r) => [num(r, 'id'), { playlist: true as const, id: num(r, 'id'), name: text(r, 'name'), count: num(r, 'cnt'), thumbs: thumbs.get(num(r, 'id')) ?? [] }])),
      titles: new Map(rows.map((r) => [num(r, 'id'), text(r, 'title')])),
    }
    return this.rec
  }

  private compile(q: MediaQuery): {
    withSql: string
    join: string
    whereSql: string
    orderSql: string
    params: SQLInputValue[]
    search?: CompiledSearch
  } {
    const where: string[] = [q.filters.hidden === 'yes' ? 'm.hidden = 1' : SHOWN_SQL]
    const params: SQLInputValue[] = []
    let join = ''
    const order: string[] = q.playlistId === undefined ? ['m.pinned DESC'] : []

    if (q.section === 'continue') {
      where.push(CONTINUE_SQL)
      if (q.playlistId === undefined) order.push('w.last_played DESC NULLS LAST')
    } else {
      const sectionSql = SECTION_SQL[q.section]
      if (sectionSql) where.push(sectionSql)
    }

    if (q.folder) where.push(...folderWhere(q.folder, params))
    if (q.playlistId !== undefined) {
      join = ' JOIN (SELECT media_id, row_number() OVER (ORDER BY position, media_id) AS position FROM playlist_items WHERE playlist_id = ?) pi ON pi.media_id = m.id'
      params.unshift(q.playlistId)
      order.push('pi.position')
    }
    const f = q.filters
    if (f.script === 'any') where.push(HAS_SCRIPTS_SQL)
    else if (f.script === 'stroke') where.push("EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis = 'L0')")
    else if (f.script === 'multi') where.push('(SELECT count(*) FROM scripts s WHERE s.media_id = m.id) >= 2')
    else if (f.script === 'estim') where.push("EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis IN ('EA', 'EB', 'EV'))")
    else if (f.script === 'missing') where.push(`NOT ${HAS_SCRIPTS_SQL}`)
    if (f.type === 'vr') where.push("m.projection != 'flat'")
    else if (f.type === '2d') where.push("m.projection = 'flat'")
    if (f.watched === 'yes') where.push('coalesce(w.play_count, 0) > 0')
    else if (f.watched === 'no') where.push('coalesce(w.play_count, 0) = 0')
    if (f.minRating !== undefined && f.minRating > 0) {
      where.push('m.rating >= ?')
      params.push(f.minRating)
    }
    if (f.tag) {
      where.push('EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id AND t.name = ?)')
      params.push(f.tag)
    }
    for (const axis of f.axes ?? []) {
      where.push('EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis = ?)')
      params.push(axis)
    }

    let search: CompiledSearch | undefined
    if (q.search?.trim()) {
      where.push(`NOT EXISTS (SELECT 1 FROM excluded_folders ef WHERE ef.root_id = m.root_id AND
        (ef.folder = '' OR m.folder = ef.folder OR (m.folder > ef.folder || '/' AND m.folder < ef.folder || '0')))`)
      search = this.searchIndex.compile(q.search, { from: `${MEDIA_FROM}${join}`, where: where.join(' AND '), params: [...params] })
      join += search.join
      where.push(`(${search.where})`)
      params.unshift(...search.params)
      params.push(...search.whereParams)
      if (q.sort === 'recommended' && q.playlistId === undefined) order.push(search.order)
    }
    const dir = q.desc ? 'DESC' : 'ASC'
    const sort = q.sort
    if (sort !== 'recommended' && q.playlistId === undefined) order.push(`${SORT_SQL[sort]} ${dir}${sort === 'lastPlayed' ? ' NULLS LAST' : ''}`, `m.id ${dir}`)
    return {
      withSql: search?.withSql ?? '',
      join,
      whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '',
      orderSql: order.join(', '),
      params,
      search,
    }
  }

  counts(): LibraryCounts {
    const parts = SECTIONS.map((s) => {
      const sql = s === 'continue' ? CONTINUE_SQL : SECTION_SQL[s]
      return sql ? `coalesce(sum(${sql}), 0) AS "${s}"` : `count(*) AS "${s}"`
    })
    const row = this.stmt(`SELECT ${parts.join(', ')} ${MEDIA_FROM} WHERE ${SHOWN_SQL}`).get()
    return Object.fromEntries(SECTIONS.map((s) => [s, row ? num(row, s) : 0])) as LibraryCounts
  }

  folders(): FolderNode[] {
    const nodes = new Map<number, FolderNode>()
    for (const root of this.roots()) {
      const name = root.kind !== 'folder' ? root.name || root.path : (root.path.split(/[\\/]/).filter(Boolean).pop() ?? root.path)
      nodes.set(root.id, {
        rootId: root.id,
        folder: '',
        name,
        count: 0,
        children: [],
        excluded: false,
      })
    }
    const place = (rootNode: FolderNode, folder: string, count: number): FolderNode => {
      let parent = rootNode
      let path = ''
      for (const part of folder.split('/')) {
        path = path ? `${path}/${part}` : part
        let child = parent.children.find((c) => c.folder === path)
        if (!child) {
          child = {
            rootId: rootNode.rootId,
            folder: path,
            name: part,
            count: 0,
            children: [],
            excluded: false,
          }
          parent.children.push(child)
        }
        child.count += count
        parent = child
      }
      return parent
    }
    const rows = this.stmt(`SELECT root_id, folder, count(*) AS n FROM media m WHERE ${SHOWN_SQL} GROUP BY root_id, folder ORDER BY folder`).all()
    for (const row of rows) {
      const rootNode = nodes.get(num(row, 'root_id'))
      if (!rootNode) continue
      const count = num(row, 'n')
      rootNode.count += count
      const folder = text(row, 'folder')
      if (folder) place(rootNode, folder, count)
    }
    for (const row of this.stmt('SELECT root_id, folder FROM excluded_folders ORDER BY folder').all()) {
      const rootNode = nodes.get(num(row, 'root_id'))
      const folder = text(row, 'folder')
      if (rootNode && folder) place(rootNode, folder, 0).excluded = true
    }
    const sort = (node: FolderNode) => {
      node.children.sort((a, b) => a.name.localeCompare(b.name))
      node.children.forEach(sort)
    }
    const out = [...nodes.values()]
    out.forEach(sort)
    return out
  }

  folderMediaIds(folder: NonNullable<MediaQuery['folder']>): number[] {
    const params: SQLInputValue[] = []
    const where = folderWhere(folder, params)
    return this.stmt(`SELECT id FROM media m WHERE ${where.join(' AND ')}`).all(...params).map((r) => num(r, 'id'))
  }

  excludedFolders(rootId: number): string[] {
    return this.stmt('SELECT folder FROM excluded_folders WHERE root_id = ?')
      .all(rootId)
      .map((r) => text(r, 'folder'))
  }

  excludeFolder(folder: NonNullable<MediaQuery['folder']>) {
    this.stmt('INSERT OR IGNORE INTO excluded_folders (root_id, folder) VALUES (?, ?)').run(folder.rootId, folder.folder)
  }

  includeFolder(folder: NonNullable<MediaQuery['folder']>) {
    this.stmt('DELETE FROM excluded_folders WHERE root_id = ? AND folder = ?').run(folder.rootId, folder.folder)
  }

  tags(): Tag[] {
    return this.stmt(
      `SELECT t.name, (SELECT count(*) FROM media_tags mt JOIN media m ON m.id = mt.media_id WHERE mt.tag_id = t.id AND ${SHOWN_SQL}) AS n
       FROM tags t ORDER BY t.name`,
    )
      .all()
      .map((r) => ({ name: text(r, 'name'), count: num(r, 'n') }))
  }

  setTags(mediaId: number, tags: string[]) {
    const names = [...new Set(tags.map(tagName).filter(Boolean))]
    this.transaction(() => {
      this.stmt('DELETE FROM media_tags WHERE media_id = ?').run(mediaId)
      for (const name of names) {
        this.stmt('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
        this.stmt('INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(mediaId, name)
      }
      this.stmt('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM media_tags)').run()
    })
  }

  addTags(mediaId: number, tags: string[]) {
    const names = [...new Set(tags.map(tagName).filter(Boolean))]
    if (names.length === 0) return
    this.transaction(() => {
      for (const name of names) {
        this.stmt('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
        this.stmt('INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(mediaId, name)
      }
    })
  }

  addTag(mediaIds: number[], tag: string) {
    const name = tagName(tag)
    if (!name) return
    this.transaction(() => {
      this.stmt('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
      const link = this.stmt('INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT ?, id FROM tags WHERE name = ?')
      for (const id of mediaIds) link.run(id, name)
    })
  }

  renameTag(from: string, to: string): string {
    const name = tagName(to)
    if (!name || name === from) return from
    this.transaction(() => {
      const old = this.stmt('SELECT id FROM tags WHERE name = ?').get(from)
      if (!old) return
      const taken = this.stmt('SELECT id FROM tags WHERE name = ?').get(name)
      if (taken) {
        this.stmt('INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT media_id, ? FROM media_tags WHERE tag_id = ?').run(num(taken, 'id'), num(old, 'id'))
        this.stmt('DELETE FROM tags WHERE id = ?').run(num(old, 'id'))
      } else this.stmt('UPDATE tags SET name = ? WHERE id = ?').run(name, num(old, 'id'))
    })
    return name
  }

  deleteTag(name: string) {
    this.stmt('DELETE FROM tags WHERE name = ?').run(name)
  }

  mediaIdByPath(path: string): number | null {
    const row = this.stmt('SELECT id FROM media WHERE path = ?').get(path)
    return row ? num(row, 'id') : null
  }

  played(mediaId: number, now: number) {
    this.stmt(
      `INSERT INTO watch (media_id, play_count, last_played) VALUES (?, 1, ?)
       ON CONFLICT(media_id) DO UPDATE SET play_count = play_count + 1, last_played = excluded.last_played`,
    ).run(mediaId, now)
  }

  startSession(plannedMs: number, now: number, run?: SessionRun, name = 'Session'): number {
    const { lastInsertRowid } = this.stmt('INSERT INTO sessions (started_at, planned_ms, name, status, run_json) VALUES (?, ?, ?, ?, ?)').run(now, plannedMs, name, run ? 'running' : 'legacy', run ? JSON.stringify(run) : null)
    return Number(lastInsertRowid)
  }

  finishSession(id: number, completed: boolean, now: number) {
    this.stmt("UPDATE sessions SET ended_at = ?, status = ? WHERE id = ? AND status = 'running'").run(now, completed ? 'completed' : 'interrupted', id)
  }

  sessionHistory(): SessionHistory[] {
    return this.stmt('SELECT s.*, (SELECT count(*) FROM session_items i WHERE i.session_id = s.id) AS played_count FROM sessions s WHERE s.favourite = 1 OR s.id IN (SELECT id FROM sessions ORDER BY started_at DESC, id DESC LIMIT 50) ORDER BY started_at DESC, id DESC').all().map(row => {
      const raw = text(row, 'run_json')
      let run: SessionRun | null = null
      try { run = raw ? sessionRun(JSON.parse(raw), t) : null } catch { }
      const status = text(row, 'status')
      return { id: num(row, 'id'), name: text(row, 'name'), favourite: num(row, 'favourite') === 1, startedAt: num(row, 'started_at'), endedAt: numOrNull(row, 'ended_at'), status: status === 'completed' || status === 'interrupted' || status === 'running' ? status : 'legacy', totalMs: num(row, 'planned_ms'), clipCount: run?.clips.length ?? num(row, 'played_count'), run }
    })
  }

  savedSessions(): SavedSession[] {
    return this.stmt('SELECT * FROM saved_sessions ORDER BY updated_at DESC, id DESC').all().flatMap(row => {
      try { return [{ id: num(row, 'id'), name: text(row, 'name'), favourite: num(row, 'favourite') === 1, updatedAt: num(row, 'updated_at'), setup: sessionSetup(JSON.parse(text(row, 'setup_json')), t) }] } catch { return [] }
    })
  }

  saveSession(name: string, setup: SessionSetup, favourite: boolean, now: number): number {
    const title = name.trim().slice(0, 120)
    if (!title) throw new Error('Enter a name')
    return Number(this.stmt('INSERT INTO saved_sessions (name, favourite, updated_at, setup_json) VALUES (?, ?, ?, ?)').run(title, favourite ? 1 : 0, now, JSON.stringify(sessionSetup(setup, t))).lastInsertRowid)
  }

  favouriteSession(kind: 'saved' | 'history', id: number, favourite: boolean) {
    if (kind === 'saved') this.stmt('UPDATE saved_sessions SET favourite = ? WHERE id = ?').run(favourite ? 1 : 0, id)
    else this.stmt('UPDATE sessions SET favourite = ? WHERE id = ?').run(favourite ? 1 : 0, id)
  }

  deleteSavedSession(id: number) { this.stmt('DELETE FROM saved_sessions WHERE id = ?').run(id) }

  sessionPlayed(sessionId: number, mediaId: number, startMs: number, endMs: number) {
    this.stmt(
      `INSERT INTO session_items (session_id, media_id, position, start_ms, end_ms)
       VALUES (?, ?, (SELECT coalesce(max(position), -1) + 1 FROM session_items WHERE session_id = ?), ?, ?)`,
    ).run(sessionId, mediaId, sessionId, startMs, endMs)
  }

  recentSessionMediaIds(sessions: number): number[] {
    if (sessions <= 0) return []
    return this.stmt(
      `SELECT DISTINCT media_id FROM session_items WHERE session_id IN (
         SELECT s.id FROM sessions s WHERE EXISTS (SELECT 1 FROM session_items i WHERE i.session_id = s.id)
         ORDER BY s.started_at DESC LIMIT ?)`,
    )
      .all(sessions)
      .map((r) => num(r, 'media_id'))
  }

  videoSettings(key: string): VideoSettingsRow | null {
    const row = this.stmt('SELECT position_ms, settings FROM video_settings WHERE key = ?').get(key)
    return row ? { positionMs: numOrNull(row, 'position_ms'), settings: text(row, 'settings') } : null
  }

  setVideoSettings(key: string, row: VideoSettingsRow, now: number) {
    this.stmt(
      `INSERT INTO video_settings (key, position_ms, settings, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET position_ms = excluded.position_ms, settings = excluded.settings, updated_at = excluded.updated_at`,
    ).run(key, row.positionMs, row.settings, now)
  }

  removeVideoSettings(key: string) {
    this.stmt('DELETE FROM video_settings WHERE key = ?').run(key)
  }

  generated(key: string): GeneratedRows | null {
    const rows = this.stmt('SELECT axis, settings_hash, stamp, json FROM generated WHERE key = ? ORDER BY axis').all(key)
    const first = rows[0]
    if (!first) return null
    const scripts: GeneratedScriptRow[] = []
    for (const row of rows) {
      const axis = text(row, 'axis')
      if (isAxisId(axis)) scripts.push({ axis, json: text(row, 'json') })
    }
    return { hash: text(first, 'settings_hash'), stamp: text(first, 'stamp'), scripts }
  }

  setGenerated(key: string, hash: string, stamp: string, scripts: GeneratedScriptRow[], now: number) {
    this.transaction(() => {
      this.stmt('DELETE FROM generated WHERE key = ?').run(key)
      const insert = this.stmt('INSERT INTO generated (key, axis, settings_hash, stamp, json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const s of scripts) insert.run(key, s.axis, hash, stamp, s.json, now)
    })
  }

  removeGenerated(key: string) {
    this.stmt('DELETE FROM generated WHERE key = ?').run(key)
  }

  editorFiles(q: EditorFileQuery): EditorFilePage {
    const params: SQLInputValue[] = []
    const where = ["f.path NOT LIKE 'http://%'", "f.path NOT LIKE 'https://%'", '(m.id IS NULL OR m.hidden = 0)']
    const extensions = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]
    where.push(`(${extensions.map(() => 'lower(f.path) LIKE ?').join(' OR ')})`)
    params.push(...extensions.map((extension) => `%.${extension}`))
    if (q.source === 'recent') where.push('e.edited_at IS NOT NULL')
    else where.push('m.id IS NOT NULL')
    if (q.folder) where.push(...folderWhere(q.folder, params))
    const search = q.search.trim()
    if (search) {
      where.push("(instr(lower(coalesce(m.title, '')), lower(?)) > 0 OR instr(lower(f.path), lower(?)) > 0)")
      params.push(search, search)
    }
    const limit = 100
    const offset = Number.isFinite(q.offset) ? Math.max(0, Math.floor(q.offset)) : 0
    const rows = this.stmt(`
      WITH edits AS (
        SELECT key, max(updated_at) AS edited_at,
          max(CASE WHEN kind = 'saved' THEN updated_at END) AS saved_at,
          max(CASE WHEN kind = 'draft' THEN updated_at END) AS draft_at
        FROM editor_docs WHERE kind IN ('saved', 'draft') GROUP BY key
      ), files AS (
        SELECT path FROM media UNION SELECT key AS path FROM edits
      )
      SELECT f.path, m.title, m.duration_ms, m.axes, e.edited_at, e.saved_at, e.draft_at
      FROM files f LEFT JOIN media m ON m.path = f.path LEFT JOIN edits e ON e.key = f.path
      WHERE ${where.join(' AND ')}
      ORDER BY ${q.source === 'recent' ? 'e.edited_at DESC,' : ''} coalesce(m.title, f.path) COLLATE NOCASE, f.path
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset)
    return {
      hasMore: rows.length > limit,
      files: rows.slice(0, limit).map((row) => {
        const path = text(row, 'path')
        const saved = numOrNull(row, 'saved_at')
        const draft = numOrNull(row, 'draft_at')
        return {
          path, title: text(row, 'title') || basename(path), folder: dirname(path),
          durationMs: numOrNull(row, 'duration_ms'), axes: strings(text(row, 'axes')).filter(isAxisId),
          editedAt: numOrNull(row, 'edited_at'), saved: saved !== null,
          draft: draft !== null && (saved === null || draft > saved),
        }
      }),
    }
  }

  editorFolders(): FolderNode[] {
    const local = new Set(this.roots().filter((root) => root.kind === 'folder').map((root) => root.id))
    return this.folders().filter((folder) => local.has(folder.rootId))
  }

  editorDoc(key: string, kind: EditorDocKind): { doc: Uint8Array; updatedAt: number } | null {
    const row = this.stmt('SELECT doc, updated_at FROM editor_docs WHERE key = ? AND kind = ?').get(key, kind)
    const doc = row?.doc
    return row && doc instanceof Uint8Array ? { doc, updatedAt: num(row, 'updated_at') } : null
  }

  setEditorDoc(key: string, kind: EditorDocKind, doc: Uint8Array, now: number) {
    this.stmt('INSERT INTO editor_docs (key, kind, doc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key, kind) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at').run(key, kind, doc, now)
  }

  removeEditorDoc(key: string, kind: EditorDocKind) {
    this.stmt('DELETE FROM editor_docs WHERE key = ? AND kind = ?').run(key, kind)
  }

  patterns(): Array<{ id: string; name: string; points: string }> {
    return this.stmt('SELECT id, name, points FROM editor_patterns ORDER BY updated_at DESC').all().map((row) => ({ id: text(row, 'id'), name: text(row, 'name'), points: text(row, 'points') }))
  }

  setPattern(id: string, name: string, points: string, now: number) {
    this.stmt('INSERT INTO editor_patterns (id, name, points, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, points = excluded.points, updated_at = excluded.updated_at').run(id, name, points, now, now)
  }

  removePattern(id: string) {
    this.stmt('DELETE FROM editor_patterns WHERE id = ?').run(id)
  }

  exportsSince(at: number): number {
    const row = this.stmt('SELECT count(*) AS n FROM editor_exports WHERE at >= ?').get(at)
    return row ? num(row, 'n') : 0
  }

  recordExport(at: number) {
    this.stmt('INSERT INTO editor_exports (at) VALUES (?)').run(at)
  }

  importGroups(rootId: number, groups: readonly { key: string; name: string; sceneKeys: string[] }[]) {
    return this.transaction(() => {
      if (this.server(rootId)?.kind !== 'stash') throw new Error(t('library.error.stashUnavailable'))
      const result = { created: 0, updated: 0, skipped: 0 }
      const members = new Map(this.stmt(`SELECT remote_key, id FROM media WHERE root_id = ? AND hidden = 0
        AND folder NOT IN (SELECT folder FROM excluded_folders WHERE root_id = ?)`).all(rootId, rootId).map((r) => [text(r, 'remote_key'), num(r, 'id')]))
      for (const group of groups) {
        const previous = this.stmt('SELECT playlist_id, snapshot FROM imported_groups WHERE root_id = ? AND group_id = ?').get(rootId, group.key)
        let id: number
        if (previous) {
          id = num(previous, 'playlist_id')
          const current = this.stmt('SELECT name FROM playlists WHERE id = ?').get(id)
          const mediaIds = this.stmt('SELECT media_id FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(id).map((r) => num(r, 'media_id'))
          const snapshot: unknown = JSON.parse(text(previous, 'snapshot'))
          const expected = Array.isArray(snapshot) && Array.isArray(snapshot[1])
            ? JSON.stringify([snapshot[0], snapshot[1].filter((id: unknown) => typeof id === 'number' && this.stmt('SELECT 1 FROM media WHERE id = ?').get(id))])
            : ''
          if (JSON.stringify([current ? text(current, 'name') : '', mediaIds]) !== expected) {
            result.skipped++
            continue
          }
          this.renamePlaylist(id, group.name)
          this.stmt('DELETE FROM playlist_items WHERE playlist_id = ?').run(id)
          result.updated++
        } else {
          id = this.createPlaylist(group.name).id
          result.created++
        }
        const mediaIds = [...new Set(group.sceneKeys.flatMap((key) => { const id = members.get(key); return id === undefined ? [] : [id] }))]
        this.addToPlaylist(id, mediaIds)
        this.stmt('INSERT INTO imported_groups (root_id, group_id, playlist_id, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT(root_id, group_id) DO UPDATE SET snapshot = excluded.snapshot').run(rootId, group.key, id, JSON.stringify([group.name, mediaIds]))
      }
      this.rec = null
      return result
    })
  }

  remoteAsset(id: number, kind: 'thumb' | 'strip') {
    const row = this.stmt('SELECT source, checked_at, digest FROM remote_assets WHERE media_id = ? AND kind = ?').get(id, kind)
    return row ? { source: text(row, 'source'), checkedAt: num(row, 'checked_at'), digest: text(row, 'digest') } : null
  }

  setRemoteAsset(id: number, kind: 'thumb' | 'strip', source: string, digest: string, at: number) {
    this.stmt('INSERT INTO remote_assets (media_id, kind, source, digest, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, kind) DO UPDATE SET source = excluded.source, digest = excluded.digest, checked_at = excluded.checked_at').run(id, kind, source, digest, at)
    if (kind === 'thumb') this.setCoverStamp(id, digest)
    else this.stmt('UPDATE media SET strip_stamp = ? WHERE id = ?').run(digest, id)
  }

  playlists(): Playlist[] {
    return this.stmt('SELECT p.id, p.name, (SELECT count(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS n FROM playlists p ORDER BY p.name COLLATE NOCASE').all().map(toPlaylist)
  }

  createPlaylist(name: string): Playlist {
    const { lastInsertRowid } = this.stmt('INSERT INTO playlists (name) VALUES (?)').run(name)
    return { id: Number(lastInsertRowid), name, count: 0 }
  }

  renamePlaylist(id: number, name: string) {
    this.rec = null
    this.stmt('UPDATE playlists SET name = ? WHERE id = ?').run(name, id)
  }

  deletePlaylist(id: number) {
    this.stmt('DELETE FROM playlists WHERE id = ?').run(id)
  }

  addToPlaylist(id: number, mediaIds: number[]) {
    this.transaction(() => {
      const insert = this.stmt('INSERT OR IGNORE INTO playlist_items (playlist_id, media_id, position) SELECT ?, ?, coalesce(max(position), 0) + 1 FROM playlist_items WHERE playlist_id = ?')
      for (const mediaId of mediaIds) insert.run(id, mediaId, id)
    })
  }

  removeFromPlaylist(id: number, mediaIds: number[]) {
    this.transaction(() => {
      const del = this.stmt('DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?')
      for (const mediaId of mediaIds) del.run(id, mediaId)
    })
  }

  movePlaylistItems(id: number, move: PlaylistMove) {
    if (!Number.isSafeInteger(id) || !Array.isArray(move.mediaIds) || !move.mediaIds.every(Number.isSafeInteger) || !Number.isSafeInteger(move.anchorId) || !['before', 'after'].includes(move.side)) throw new Error(t('library.playlist.invalidMove'))
    this.transaction(() => {
      const order = this.stmt('SELECT media_id FROM playlist_items WHERE playlist_id = ? ORDER BY position, media_id').all(id).map(row => num(row, 'media_id'))
      const next = movePlaylistItems(order, move, t)
      if (next.every((mediaId, i) => mediaId === order[i])) return
      const update = this.stmt('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND media_id = ?')
      next.forEach((mediaId, i) => update.run(i + 1, id, mediaId))
      this.rec = null
    })
  }

  indexRows(section: 'all' | 'continue'): MediaIndexRow[] {
    const sql =
      section === 'continue'
        ? `SELECT m.id, m.title, m.duration_ms ${MEDIA_FROM} WHERE ${SHOWN_SQL} AND ${CONTINUE_SQL} ORDER BY m.pinned DESC, w.last_played DESC NULLS LAST, m.id DESC`
        : `SELECT id, title, duration_ms FROM media m WHERE ${SHOWN_SQL} ORDER BY pinned DESC, added_at DESC, id DESC`
    return this.stmt(sql).all().map(toIndexRow)
  }

  tagIndexRows(tag: string): MediaIndexRow[] {
    return this.stmt(
      `SELECT m.id, m.title, m.duration_ms FROM media m JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id
       WHERE t.name = ? AND ${SHOWN_SQL} ORDER BY m.pinned DESC, m.added_at DESC, m.id DESC`,
    )
      .all(tag)
      .map(toIndexRow)
  }

  scriptSource(mediaId: number, axis: AxisId): string | null {
    const row = this.stmt("SELECT source FROM scripts WHERE media_id = ? AND axis = ? AND container = 'sibling'").get(mediaId, axis)
    return row ? text(row, 'source') : null
  }
}

const toIndexRow = (r: Row): MediaIndexRow => ({
  id: num(r, 'id'),
  title: text(r, 'title'),
  durationMs: num(r, 'duration_ms'),
})

function toRoot(row: Row): LibraryRoot {
  const kind = text(row, 'kind')
  return {
    id: num(row, 'id'),
    path: text(row, 'path'),
    kind: ROOT_KINDS.find((k) => k === kind) ?? 'folder',
    name: text(row, 'name'),
    sessions: num(row, 'sessions') === 1,
    lastScan: numOrNull(row, 'last_scan'),
    error: text(row, 'error'),
  }
}

function toPlaylist(row: Row): Playlist {
  return { id: num(row, 'id'), name: text(row, 'name'), count: num(row, 'n') }
}

function toScript(row: Row): ScriptRow {
  const axis = text(row, 'axis')
  return {
    axis: isAxisId(axis) ? axis : 'L0',
    source: text(row, 'source'),
    container: text(row, 'container'),
    actions: num(row, 'actions'),
    durationMs: num(row, 'duration_ms'),
    averageSpeed: num(row, 'average_speed'),
    maxSpeed: num(row, 'max_speed'),
    heatmap: numbers(text(row, 'heatmap')),
  }
}

const coverKey = (stamp: string) => (stamp ? `&c=${encodeURIComponent(stamp)}` : '')

function toMediaRow(row: Row): MediaRow {
  const id = num(row, 'id')
  const mtime = num(row, 'mtime')
  const projection = text(row, 'projection')
  return {
    id,
    ...(row.playlist_position === undefined ? {} : { playlistPosition: num(row, 'playlist_position') }),
    rootId: num(row, 'root_id'),
    path: text(row, 'path'),
    title: text(row, 'title'),
    titleSet: num(row, 'title_set') === 1,
    folder: text(row, 'folder'),
    size: num(row, 'size'),
    mtime,
    addedAt: num(row, 'added_at'),
    durationMs: num(row, 'duration_ms'),
    width: num(row, 'width'),
    height: num(row, 'height'),
    codec: text(row, 'codec'),
    projection: PROJECTION_KINDS.find((k) => k === projection) ?? 'flat',
    thumb: num(row, 'thumb_ready') === 1 ? `thumb://media/${id}?v=${mtime}${coverKey(text(row, 'cover_stamp'))}&q=${num(row, 'thumb_quality')}` : null,
    strip: num(row, 'strip_ready') === 1 ? `thumb://strip/${id}?v=${mtime}${coverKey(text(row, 'strip_stamp'))}&q=${num(row, 'strip_quality')}` : null,
    axes: strings(text(row, 'axes')).filter(isAxisId),
    averageSpeed: num(row, 'average_speed'),
    heat: numbers(text(row, 'heat')),
    rating: num(row, 'rating'),
    favourite: num(row, 'favourite') === 1,
    watchedMs: numOrNull(row, 'position_ms'),
    playCount: num(row, 'play_count'),
    lastPlayed: numOrNull(row, 'last_played'),
    tags: strings(text(row, 'tag_names')),
    pinned: num(row, 'pinned') > 0,
    hidden: num(row, 'hidden') === 1,
  }
}

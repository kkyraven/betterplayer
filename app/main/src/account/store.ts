import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { SyncPayload, SyncRow } from '@shared/account'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hashes (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS hashes_hash ON hashes(hash);
CREATE TABLE IF NOT EXISTS synced (hash TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, applied_at INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (hash TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (feature TEXT PRIMARY KEY, count INTEGER NOT NULL);
`

type Row = Record<string, SQLOutputValue>
const text = (row: Row, key: string) => String(row[key] ?? '')
const num = (row: Row, key: string) => Number(row[key] ?? 0)

export interface SyncedRow extends SyncRow {
  appliedAt: number
}

export class AccountDb {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  close() {
    this.db.close()
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  meta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? text(row, 'value') : null
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.stmt('DELETE FROM meta WHERE key = ?').run(key)
    else this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  hash(path: string, stamp: string): string | null {
    const row = this.stmt('SELECT hash FROM hashes WHERE path = ? AND stamp = ?').get(path, stamp)
    return row ? text(row, 'hash') : null
  }

  setHash(path: string, stamp: string, hash: string) {
    this.stmt('INSERT INTO hashes (path, stamp, hash) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET stamp = excluded.stamp, hash = excluded.hash').run(path, stamp, hash)
  }

  pathsForHash(hash: string): string[] {
    return this.stmt('SELECT path FROM hashes WHERE hash = ?').all(hash).map((r) => text(r, 'path'))
  }

  hasHash(path: string): boolean {
    return this.stmt('SELECT 1 FROM hashes WHERE path = ?').get(path) !== undefined
  }

  synced(hash: string): SyncedRow | null {
    const row = this.stmt('SELECT hash, updated_at, applied_at, payload FROM synced WHERE hash = ?').get(hash)
    return row ? { hash, updatedAt: num(row, 'updated_at'), appliedAt: num(row, 'applied_at'), payload: JSON.parse(text(row, 'payload')) as SyncPayload } : null
  }

  takeSynced(row: SyncRow): boolean {
    const result = this.stmt(
      `INSERT INTO synced (hash, updated_at, payload) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload WHERE synced.updated_at < excluded.updated_at`,
    ).run(row.hash, row.updatedAt, JSON.stringify(row.payload))
    return result.changes > 0
  }

  putLocal(row: SyncRow) {
    const payload = JSON.stringify(row.payload)
    this.stmt(
      `INSERT INTO synced (hash, updated_at, applied_at, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET updated_at = excluded.updated_at, applied_at = excluded.applied_at, payload = excluded.payload`,
    ).run(row.hash, row.updatedAt, row.updatedAt, payload)
    this.stmt('INSERT INTO pending (hash, updated_at, payload) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload').run(row.hash, row.updatedAt, payload)
  }

  markApplied(hash: string, updatedAt: number) {
    this.stmt('UPDATE synced SET applied_at = ? WHERE hash = ?').run(updatedAt, hash)
  }

  pending(limit: number): SyncRow[] {
    return this.stmt('SELECT hash, updated_at, payload FROM pending ORDER BY updated_at LIMIT ?')
      .all(limit)
      .map((r) => ({ hash: text(r, 'hash'), updatedAt: num(r, 'updated_at'), payload: JSON.parse(text(r, 'payload')) as SyncPayload }))
  }

  clearPending(rows: SyncRow[]) {
    const del = this.stmt('DELETE FROM pending WHERE hash = ? AND updated_at = ?')
    for (const r of rows) del.run(r.hash, r.updatedAt)
  }

  bumpUsage(feature: string) {
    const bumped = this.stmt('UPDATE usage SET count = count + 1 WHERE feature = ?').run(feature)
    if (bumped.changes > 0) return
    this.stmt('INSERT INTO usage (feature, count) SELECT ?, 1 WHERE (SELECT count(*) FROM usage) < 64').run(feature)
  }

  usage(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.stmt('SELECT feature, count FROM usage').all()) out[text(r, 'feature')] = num(r, 'count')
    return out
  }

  clearUsage(sent: Record<string, number>) {
    const dec = this.stmt('UPDATE usage SET count = count - ? WHERE feature = ?')
    for (const [feature, count] of Object.entries(sent)) dec.run(count, feature)
    this.db.exec('DELETE FROM usage WHERE count <= 0')
  }

  dropUsage() {
    this.db.exec('DELETE FROM usage')
  }

  clearSync() {
    this.db.exec('DELETE FROM synced; DELETE FROM pending')
  }
}

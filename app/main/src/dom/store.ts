// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { DOM_MEMORY_KINDS, normalizeDom, type DomMemory, type DomMemoryKind, type DomProfile } from '@shared/dom'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doms (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, dom_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS memories_dom ON memories(dom_id, created_at);
`

const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined

function migrate(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >= 1) return
  db.exec('BEGIN')
  try {
    if (!hasColumn(db, 'memories', 'al_id')) db.exec('ALTER TABLE memories ADD COLUMN al_id TEXT')
    if (!hasColumn(db, 'memories', 'removed')) db.exec('ALTER TABLE memories ADD COLUMN removed INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS memories_al ON memories(dom_id, al_id)')
    db.exec('PRAGMA user_version = 1')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

type Row = Record<string, SQLOutputValue>
const text = (row: Row, key: string) => String(row[key] ?? '')
const kindOf = (v: string): DomMemoryKind => DOM_MEMORY_KINDS.find((k) => k === v) ?? 'reaction'

export class DomDb {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    migrate(this.db)
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

  doms(): DomProfile[] {
    return this.stmt('SELECT id, json FROM doms').all().map((r) => {
      let raw: unknown = null
      try {
        raw = JSON.parse(text(r, 'json'))
      } catch {
      }
      return normalizeDom(raw, text(r, 'id'), Date.now())
    }).sort((a, b) => a.createdAt - b.createdAt)
  }

  putDom(dom: DomProfile) {
    this.stmt('INSERT INTO doms (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(dom.id, JSON.stringify(dom), dom.updatedAt)
  }

  deleteDom(id: string) {
    this.stmt('DELETE FROM doms WHERE id = ?').run(id)
    this.stmt('DELETE FROM memories WHERE dom_id = ?').run(id)
  }

  memories(domId: string): DomMemory[] {
    return this.stmt('SELECT id, kind, content, created_at, al_id FROM memories WHERE dom_id = ? AND removed = 0 ORDER BY created_at DESC').all(domId).map((r) => ({
      id: text(r, 'id'),
      kind: kindOf(text(r, 'kind')),
      content: text(r, 'content'),
      createdAt: Number(r.created_at ?? 0),
      synced: r.al_id !== null,
    }))
  }

  addMemory(domId: string, memory: DomMemory, alId: string | null = null) {
    this.stmt('INSERT OR IGNORE INTO memories (id, dom_id, kind, content, created_at, al_id) VALUES (?, ?, ?, ?, ?, ?)').run(memory.id, domId, memory.kind, memory.content, memory.createdAt, alId)
  }

  alIds(domId: string): Set<string> {
    return new Set(this.stmt('SELECT al_id FROM memories WHERE dom_id = ? AND al_id IS NOT NULL').all(domId).map((r) => text(r, 'al_id')))
  }

  markSent(domId: string, memory: DomMemory, alId: string) {
    const { changes } = this.stmt('UPDATE memories SET al_id = ? WHERE id = ?').run(alId, memory.id)
    if (!changes) this.stmt('INSERT OR IGNORE INTO memories (id, dom_id, kind, content, created_at, al_id, removed) VALUES (?, ?, ?, ?, ?, ?, 1)').run(memory.id, domId, memory.kind, memory.content, memory.createdAt, alId)
  }

  deleteMemory(id: string) {
    this.stmt('UPDATE memories SET removed = 1 WHERE id = ? AND al_id IS NOT NULL').run(id)
    this.stmt('DELETE FROM memories WHERE id = ? AND al_id IS NULL').run(id)
  }

  clearMemories(domId: string) {
    this.stmt('UPDATE memories SET removed = 1 WHERE dom_id = ? AND al_id IS NOT NULL').run(domId)
    this.stmt('DELETE FROM memories WHERE dom_id = ? AND al_id IS NULL').run(domId)
  }
}

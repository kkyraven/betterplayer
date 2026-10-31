import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DomMemory } from '@shared/dom'
import { DomDb } from './store'

let dir: string, file: string, db: DomDb
const memory = (id: string): DomMemory => ({ id, kind: 'like', content: `memory ${id}`, createdAt: 1, synced: false })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-dom-'))
  file = join(dir, 'dom.sqlite')
})
afterEach(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('dom memories', () => {
  it('keeps memories from before Agentic Lover ids', () => {
    const old = new DatabaseSync(file)
    old.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, dom_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO memories VALUES ('m', 'd', 'limit', 'No gags', 1)")
    old.close()
    db = new DomDb(file)
    expect(db.memories('d')).toEqual([{ id: 'm', kind: 'limit', content: 'No gags', createdAt: 1, synced: false }])
  })

  it('finishes a migration that stopped after adding a column', () => {
    const old = new DatabaseSync(file)
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, dom_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, al_id TEXT)')
    old.close()
    db = new DomDb(file)
    db.addMemory('d', memory('m'), 'al-1')
    expect(db.memories('d')[0]?.synced).toBe(true)
  })

  it('removes a memory from Agentic Lover here only, and remembers it was removed', () => {
    db = new DomDb(file)
    db.addMemory('d', memory('local'))
    db.addMemory('d', memory('pulled'), 'al-1')
    db.addMemory('d', memory('sent'))
    db.markSent('d', memory('sent'), 'al-2')
    db.clearMemories('d')
    expect(db.memories('d')).toEqual([])
    expect(db.alIds('d')).toEqual(new Set(['al-1', 'al-2']))
  })

  it('keeps a tombstone for a memory removed while Sync sent it', () => {
    db = new DomDb(file)
    db.addMemory('d', memory('m'))
    db.deleteMemory('m')
    db.markSent('d', memory('m'), 'al-1')
    expect(db.memories('d')).toEqual([])
    expect(db.alIds('d')).toEqual(new Set(['al-1']))
  })
})

import { randomUUID } from 'node:crypto'
import { isAxisId } from '@shared/axes'
import { PATTERN_NAME_MAX, type EditorDocument, type EditorFileQuery, type EditorStored, type Pattern } from '@shared/editor'
import type { LibraryDb } from '../library/db'
import { decodeDocument, encodeDocument } from './codec'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readDocument(raw: EditorDocument): EditorDocument {
  return {
    lanes: raw.lanes.filter((l) => isAxisId(l.axis) && Array.isArray(l.points)).map((l) => ({ axis: l.axis, points: l.points, metadata: isRecord(l.metadata) ? l.metadata : {} })),
    chapters: Array.isArray(raw.chapters) ? raw.chapters : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks : [],
    flags: Array.isArray(raw.flags) ? raw.flags.filter((f): f is number => typeof f === 'number' && Number.isFinite(f)) : [],
  }
}

function readPoints(json: string): Array<[number, number]> {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' ? [[p[0], p[1]] as [number, number]] : []))
  } catch {
    return []
  }
}

export class EditorStore {
  constructor(private readonly db: LibraryDb) {}

  files(query: EditorFileQuery) {
    return this.db.editorFiles(query)
  }

  folders() {
    return this.db.editorFolders()
  }

  load(key: string): EditorStored {
    const saved = this.db.editorDoc(key, 'saved')
    const draft = this.db.editorDoc(key, 'draft')
    const savedDoc = saved ? decodeDocument(saved.doc) : null
    const draftDoc = draft && (!saved || draft.updatedAt > saved.updatedAt) ? decodeDocument(draft.doc) : null
    const exported = this.db.editorDoc(key, 'exported')
    return { saved: savedDoc, savedAt: savedDoc ? (saved?.updatedAt ?? null) : null, draft: draftDoc, draftAt: draftDoc ? (draft?.updatedAt ?? null) : null, exported: exported ? decodeDocument(exported.doc) : null, exportedAt: exported?.updatedAt ?? null }
  }

  markExported(key: string, doc: EditorDocument): number {
    const now = Date.now()
    this.db.setEditorDoc(key, 'exported', encodeDocument(readDocument(doc)), now)
    return now
  }

  save(key: string, doc: EditorDocument): number {
    const now = Date.now()
    this.db.setEditorDoc(key, 'saved', encodeDocument(readDocument(doc)), now)
    this.db.removeEditorDoc(key, 'draft')
    return now
  }

  saveDraft(key: string, doc: EditorDocument) {
    this.db.setEditorDoc(key, 'draft', encodeDocument(readDocument(doc)), Date.now())
  }

  discardDraft(key: string) {
    this.db.removeEditorDoc(key, 'draft')
  }

  patterns(): Pattern[] {
    return this.db.patterns().map((p) => ({ id: p.id, name: p.name, points: readPoints(p.points) }))
  }

  savePattern(pattern: Pattern): Pattern[] {
    const name = pattern.name.trim().slice(0, PATTERN_NAME_MAX)
    const points = readPoints(JSON.stringify(pattern.points))
    if (name && points.length >= 2) this.db.setPattern(pattern.id || randomUUID(), name, JSON.stringify(points), Date.now())
    return this.patterns()
  }

  deletePattern(id: string): Pattern[] {
    this.db.removePattern(id)
    return this.patterns()
  }

}

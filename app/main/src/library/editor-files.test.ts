import { afterEach, beforeEach, expect, it } from 'vitest'
import { LibraryDb } from './db'

let db: LibraryDb
let root: number
beforeEach(() => { db = new LibraryDb(':memory:'); root = db.addRoot('/videos').id })
afterEach(() => db.close())

function media(name: string, folder = '', rootId = root) {
  return db.upsertMedia({ rootId, path: `/videos/${folder ? `${folder}/` : ''}${name}.mp4`, title: name, folder, size: 1, mtime: 1, durationMs: 60_000, width: 1920, height: 1080, codec: 'h264', projection: 'flat' }, 1)
}
const query = { source: 'recent' as const, search: '', offset: 0 }

it('shows edits once per file, newest first, including files outside the library', () => {
  media('saved')
  media('unopened')
  db.setEditorDoc('/videos/saved.mp4', 'saved', new Uint8Array(), 10)
  db.setEditorDoc('/videos/saved.mp4', 'draft', new Uint8Array(), 30)
  db.setEditorDoc('/outside/draft.mp4', 'draft', new Uint8Array(), 20)
  db.setEditorDoc('/videos/saved.mp4', 'exported', new Uint8Array(), 99)
  const { files, hasMore } = db.editorFiles(query)
  expect(hasMore).toBe(false)
  expect(files.map((file) => file.path)).toEqual(['/videos/saved.mp4', '/outside/draft.mp4'])
  expect(files[0]).toMatchObject({ title: 'saved', editedAt: 30, saved: true, draft: true, durationMs: 60_000 })
  expect(files[1]).toMatchObject({ title: 'draft.mp4', folder: '/outside', durationMs: null, saved: false, draft: true })
})

it('includes unedited library files and treats a draft older than a save as replaced', () => {
  media('b')
  media('a')
  db.setEditorDoc('/videos/b.mp4', 'draft', new Uint8Array(), 10)
  db.setEditorDoc('/videos/b.mp4', 'saved', new Uint8Array(), 20)
  db.setEditorDoc('/outside/only.mp4', 'saved', new Uint8Array(), 30)
  const { files } = db.editorFiles({ ...query, source: 'library' })
  expect(files.map((file) => file.title)).toEqual(['a', 'b'])
  expect(files[0]).toMatchObject({ editedAt: null, saved: false, draft: false })
  expect(files[1]).toMatchObject({ editedAt: 20, saved: true, draft: false })
})

it('keeps folder queries inside the selected root and subtree', () => {
  media('a', 'Practice')
  media('b', 'Practice/Slow')
  media('c', 'Practice extra')
  media('d', 'Practice', db.addRoot('/other').id)
  expect(db.editorFiles({ ...query, source: 'library', folder: { rootId: root, folder: 'Practice' } }).files.map((file) => file.title)).toEqual(['a', 'b'])
})

it('searches titles and paths literally and excludes hidden or remote media', () => {
  media('100%')
  media('1000')
  const hidden = media('hidden')
  db.setHidden([hidden], true)
  db.setEditorDoc('/videos/hidden.mp4', 'saved', new Uint8Array(), 50)
  db.setEditorDoc('https://example.test/video.mp4', 'saved', new Uint8Array(), 60)
  db.setEditorDoc('/outside/poster.png', 'saved', new Uint8Array(), 70)
  db.setEditorDoc('/outside/MIX.mp4', 'saved', new Uint8Array(), 10)
  expect(db.editorFiles({ ...query, source: 'library', search: '%' }).files.map((file) => file.title)).toEqual(['100%'])
  expect(db.editorFiles({ ...query, search: 'mix' }).files.map((file) => file.path)).toEqual(['/outside/MIX.mp4'])
  expect(db.editorFiles(query).files.map((file) => file.path)).toEqual(['/outside/MIX.mp4'])
})

it('pages through files with equal timestamps without duplicates', () => {
  for (let n = 0; n < 105; n++) db.setEditorDoc(`/outside/${String(n).padStart(3, '0')}.mp4`, 'saved', new Uint8Array(), 10)
  const first = db.editorFiles(query)
  const second = db.editorFiles({ ...query, offset: first.files.length })
  expect(first.files).toHaveLength(100)
  expect(first.hasMore).toBe(true)
  expect(second.files).toHaveLength(5)
  expect(second.hasMore).toBe(false)
  expect(new Set([...first.files, ...second.files].map((file) => file.path)).size).toBe(105)
})

it('only offers local library folders', () => {
  media('a', 'Practice/Slow')
  db.addServer({ kind: 'stash', url: 'http://stash', name: 'Stash', username: '', secret: '' })
  expect(db.editorFolders().map((folder) => folder.rootId)).toEqual([root])
  expect(db.editorFolders()[0]?.children[0]?.children[0]?.folder).toBe('Practice/Slow')
})

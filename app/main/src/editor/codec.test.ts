import { describe, expect, it } from 'vitest'
import type { EditorDocument } from '@shared/editor'
import { decodeDocument, encodeDocument } from './codec'

const doc: EditorDocument = {
  lanes: [
    { axis: 'L0', points: [{ at: 1500, pos: 12.5 }, { at: 0, pos: 100 }, { at: 1000, pos: 0 }], metadata: { title: 'T', tags: ['a', 'b'] } },
    { axis: 'R1', points: [], metadata: {} },
  ],
  chapters: [{ name: 'Intro', startMs: 0, endMs: 5000 }],
  bookmarks: [{ name: 'here', atMs: 1200 }],
  flags: [3000, 4500],
}

describe('editor document codec', () => {
  it('round trips with points sorted and positions to two decimals', () => {
    const out = decodeDocument(encodeDocument(doc))
    expect(out).toEqual({
      ...doc,
      lanes: [{ axis: 'L0', points: [{ at: 0, pos: 100 }, { at: 1000, pos: 0 }, { at: 1500, pos: 12.5 }], metadata: { title: 'T', tags: ['a', 'b'] } }, doc.lanes[1]],
    })
  })

  it('is not readable as a funscript and rejects other bytes', () => {
    const bytes = encodeDocument(doc)
    expect(bytes.toString('utf8')).not.toContain('actions')
    expect(bytes.toString('utf8')).not.toContain('"at"')
    expect(decodeDocument(Buffer.from('{"actions":[]}'))).toBeNull()
    expect(decodeDocument(Buffer.alloc(0))).toBeNull()
  })
})

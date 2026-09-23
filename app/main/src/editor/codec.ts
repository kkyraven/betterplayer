import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { isAxisId } from '@shared/axes'
import type { EditorBookmark, EditorChapter, EditorDocument, EditorLane, EditorPoint } from '@shared/editor'

const MAGIC = 'BPE1'
const VERSION = 1
const POS_SCALE = 100
const MASK_SEED = 0x9e3779b9

interface Header {
  v: number
  lanes: Array<{ axis: string; n: number; metadata: Record<string, unknown> }>
  chapters: EditorChapter[]
  bookmarks: EditorBookmark[]
  flags: number[]
}

class Writer {
  private buf = Buffer.alloc(1 << 16)
  private len = 0

  private room(n: number) {
    if (this.len + n <= this.buf.length) return
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n))
    this.buf.copy(next, 0, 0, this.len)
    this.buf = next
  }

  varint(value: number) {
    let v = Math.max(0, Math.round(value))
    this.room(10)
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80
      v = Math.floor(v / 128)
    }
    this.buf[this.len++] = v
  }

  bytes(b: Uint8Array) {
    this.room(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
  }

  take(): Buffer {
    return this.buf.subarray(0, this.len)
  }
}

class Reader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  varint(): number {
    let v = 0
    let mul = 1
    for (;;) {
      const b = this.buf[this.pos++]
      if (b === undefined) throw new Error('short')
      v += (b & 0x7f) * mul
      if ((b & 0x80) === 0) return v
      mul *= 128
    }
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('short')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

function mask(bytes: Buffer): Buffer {
  let x = MASK_SEED >>> 0
  const out = Buffer.alloc(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = (bytes[i] ?? 0) ^ (x & 0xff)
  }
  return out
}

const sortedPoints = (points: EditorPoint[]): EditorPoint[] =>
  points
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.pos))
    .map((p) => ({ at: Math.max(0, Math.round(p.at)), pos: Math.min(100, Math.max(0, p.pos)) }))
    .sort((a, b) => a.at - b.at)

export function encodeDocument(doc: EditorDocument): Buffer {
  const lanes = doc.lanes.map((l) => ({ axis: l.axis, points: sortedPoints(l.points), metadata: l.metadata }))
  const header: Header = {
    v: VERSION,
    lanes: lanes.map((l) => ({ axis: l.axis, n: l.points.length, metadata: l.metadata })),
    chapters: doc.chapters,
    bookmarks: doc.bookmarks,
    flags: doc.flags,
  }
  const w = new Writer()
  w.bytes(Buffer.from(MAGIC, 'ascii'))
  const head = Buffer.from(JSON.stringify(header), 'utf8')
  w.varint(head.length)
  w.bytes(head)
  for (const lane of lanes) {
    let last = 0
    for (const p of lane.points) {
      w.varint(p.at - last)
      last = p.at
      w.varint(Math.round(p.pos * POS_SCALE))
    }
  }
  return mask(deflateRawSync(w.take()))
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readChapters(raw: unknown): EditorChapter[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c) => (isRecord(c) && typeof c.name === 'string' && finite(c.startMs) && finite(c.endMs) ? [{ name: c.name, startMs: c.startMs, endMs: c.endMs }] : []))
}

function readBookmarks(raw: unknown): EditorBookmark[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((b) => (isRecord(b) && typeof b.name === 'string' && finite(b.atMs) ? [{ name: b.name, atMs: b.atMs }] : []))
}

export function decodeDocument(bytes: Uint8Array): EditorDocument | null {
  try {
    const plain = inflateRawSync(mask(Buffer.from(bytes)))
    const r = new Reader(plain)
    if (Buffer.from(r.bytes(4)).toString('ascii') !== MAGIC) return null
    const header: unknown = JSON.parse(Buffer.from(r.bytes(r.varint())).toString('utf8'))
    if (!isRecord(header) || header.v !== VERSION || !Array.isArray(header.lanes)) return null
    const lanes: EditorLane[] = []
    for (const raw of header.lanes) {
      if (!isRecord(raw) || typeof raw.axis !== 'string' || !isAxisId(raw.axis) || !finite(raw.n)) return null
      const points: EditorPoint[] = []
      let last = 0
      for (let i = 0; i < raw.n; i++) {
        last += r.varint()
        points.push({ at: last, pos: r.varint() / POS_SCALE })
      }
      lanes.push({ axis: raw.axis, points, metadata: isRecord(raw.metadata) ? raw.metadata : {} })
    }
    const flags = Array.isArray(header.flags) ? header.flags.filter(finite).map(Math.round) : []
    return { lanes, chapters: readChapters(header.chapters), bookmarks: readBookmarks(header.bookmarks), flags }
  } catch {
    return null
  }
}

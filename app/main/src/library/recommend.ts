export interface RecommendVideo {
  id: number
  playCount: number
  lastPlayed: number | null
  addedAt: number
}

export interface RecommendPlaylist {
  id: number
  count: number
}

export type MixEntry = { kind: 'video'; id: number } | { kind: 'playlist'; id: number }

export function recommendSeed(dayStamp: string, ids: readonly number[]): number {
  let h = 0x811c9dc5
  const mix = (n: number) => {
    h ^= n
    h = Math.imul(h, 0x01000193)
  }
  for (let i = 0; i < dayStamp.length; i++) mix(dayStamp.charCodeAt(i))
  for (const id of [...ids].sort((a, b) => a - b)) mix(id)
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WINDOW = 7

class Bucket<T extends { id: number }> {
  private scan = 0
  private window: number[] = []
  constructor(
    readonly kind: MixEntry['kind'],
    readonly weight: number,
    private readonly items: T[],
    private readonly used: Set<number>,
  ) {}

  private topUp() {
    this.window = this.window.filter((i) => !this.used.has(this.items[i]!.id))
    while (this.window.length < WINDOW && this.scan < this.items.length) {
      const i = this.scan++
      if (!this.used.has(this.items[i]!.id)) this.window.push(i)
    }
  }

  available(): boolean {
    this.topUp()
    return this.window.length > 0
  }

  pick(rand: number): T {
    this.topUp()
    const k = Math.floor(rand * this.window.length)
    const item = this.items[this.window.splice(k, 1)[0]!]!
    this.used.add(item.id)
    return item
  }
}

const byId = (a: { id: number }, b: { id: number }) => a.id - b.id

export function mixRecommended(videos: RecommendVideo[], playlists: RecommendPlaylist[], seed: number): MixEntry[] {
  const rand = mulberry32(seed)
  const usedVideos = new Set<number>()
  const unplayed = videos.filter((v) => v.playCount === 0)
  const shuffled = [...videos]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }

  const buckets = [
    new Bucket('video', 30, videos.filter((v) => v.playCount > 0).sort((a, b) => b.playCount - a.playCount || byId(a, b)), usedVideos),
    new Bucket('video', 25, videos.filter((v) => v.lastPlayed !== null).sort((a, b) => b.lastPlayed! - a.lastPlayed! || byId(a, b)), usedVideos),
    new Bucket('video', 15, [...unplayed].sort((a, b) => b.addedAt - a.addedAt || byId(a, b)), usedVideos),
    new Bucket('playlist', 2.5, playlists.filter((p) => p.count > 0).sort((a, b) => b.count - a.count || byId(a, b)), new Set()),
    new Bucket('video', 15, [...unplayed].sort((a, b) => a.addedAt - b.addedAt || byId(a, b)), usedVideos),
    new Bucket('video', 12.5, shuffled, usedVideos),
  ]

  const out: MixEntry[] = []
  while (usedVideos.size < videos.length) {
    const open = buckets.filter((b) => b.available())
    if (open.length === 0) break
    let r = rand() * open.reduce((n, b) => n + b.weight, 0)
    let bucket = open[open.length - 1]!
    for (const b of open) {
      r -= b.weight
      if (r < 0) {
        bucket = b
        break
      }
    }
    out.push({ kind: bucket.kind, id: bucket.pick(rand()).id })
  }
  return out
}

export function holdBack(entries: MixEntry[], held: ReadonlySet<number>, head: number): MixEntry[] {
  if (held.size === 0) return entries
  const isHeld = (e: MixEntry) => e.kind === 'video' && held.has(e.id)
  const lead: MixEntry[] = []
  const moved: MixEntry[] = []
  let i = 0
  for (; i < entries.length && lead.length < head; i++) (isHeld(entries[i]!) ? moved : lead).push(entries[i]!)
  return moved.length === 0 ? entries : [...lead, ...moved, ...entries.slice(i)]
}

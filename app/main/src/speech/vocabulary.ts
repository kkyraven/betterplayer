import { chipsQuery, type Chip } from '@shared/portals'
import type { Tag } from '@shared/library'
import type { Library } from '../library'

export interface VocabularySource {
  tags(): Tag[]
  titles(): string[]
  performers(): string[]
}

export interface Vocabulary {
  tags: string[]
  prompt: string
}

const grammar = (tag: string) => `VR, 2D, favourites, fastest, under 20 minutes, over 10 minutes, ${tag} tag`
const TAGS = 40
const PERFORMERS = 30
const TITLE_WORDS = 30
const PROMPT_CHARS = 800
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'you', 'your', 'are', 'was', 'her', 'his', 'she', 'him', 'part', 'video', 'scene', 'mp4', 'mkv', 'webm'])

export function buildVocabulary(source: VocabularySource): Vocabulary {
  const tags = source.tags()
  const topTags = tags.filter((t) => t.count > 0).sort((a, b) => b.count - a.count).slice(0, TAGS).map((t) => t.name)
  const counts = new Map<string, number>()
  for (const title of source.titles()) {
    for (const w of new Set(title.toLowerCase().split(/[^\p{L}]+/u))) {
      if (w.length >= 4 && !STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  const titleWords = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, TITLE_WORDS).map(([w]) => w)
  let prompt = grammar(topTags[0] ?? 'beach')
  for (const word of [...topTags, ...source.performers().slice(0, PERFORMERS), ...titleWords]) {
    const next = `${word}, ${prompt}`
    if (next.length > PROMPT_CHARS) break
    prompt = next
  }
  return { tags: tags.map((t) => t.name), prompt }
}

const KEEP_MS = 3 * 60_000

export class VocabularyCache {
  private built: { at: number; vocabulary: Vocabulary } | null = null
  private stale = false

  constructor(private readonly source: VocabularySource, private readonly now: () => number = Date.now) {}

  changed() {
    this.stale = true
  }

  get(): Vocabulary {
    if (!this.built || (this.stale && this.now() - this.built.at >= KEEP_MS)) {
      this.built = { at: this.now(), vocabulary: buildVocabulary(this.source) }
      this.stale = false
    }
    return this.built.vocabulary
  }
}

export function librarySource(library: Pick<Library, 'tags' | 'index' | 'performerNames'>): VocabularySource {
  return {
    tags: () => library.tags(),
    titles: () => library.index('all').map((r) => r.title),
    performers: () => library.performerNames(PERFORMERS),
  }
}

export async function libraryCorrections(library: Pick<Library, 'prepareSearch' | 'query'>, chips: readonly Chip[]): Promise<{ from: string; to: string }[]> {
  const q = chipsQuery(chips, 0)
  if (!q.search) return []
  await library.prepareSearch(q)
  return library.query(q).search?.corrections ?? []
}

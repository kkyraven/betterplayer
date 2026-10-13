import { MAX_SOURCE_URL_LENGTH, MAX_TOPIC_SOURCES, isEroTopicUrl, sourceId, sourceUrl, type EroSource, type EroTopic } from '@shared/eroscripts'

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
}

export function topicReport(value: unknown, tabId: number, generation: number, currentUrl: string): EroTopic | null {
  if (!isEroTopicUrl(currentUrl) || !value || typeof value !== 'object') return null
  if (!('generation' in value) || value.generation !== generation || !Number.isSafeInteger(generation)) return null
  if (!('url' in value) || value.url !== currentUrl) return null
  if (!('title' in value) || !text(value.title, 240)) return null
  if (!('scope' in value) || value.scope !== 'loaded-posts') return null
  if (!('sources' in value) || !Array.isArray(value.sources) || value.sources.length > MAX_TOPIC_SOURCES) return null
  const sources: EroSource[] = []
  const seen = new Set<string>()
  for (const raw of value.sources) {
    if (!raw || typeof raw !== 'object') return null
    if (!('url' in raw) || !text(raw.url, MAX_SOURCE_URL_LENGTH)) return null
    const url = sourceUrl(raw.url)
    if (!url || !('label' in raw) || !text(raw.label, 512)) return null
    if (!('postNumber' in raw) || typeof raw.postNumber !== 'number' || !Number.isSafeInteger(raw.postNumber) || raw.postNumber < 1 || raw.postNumber > 1_000_000) return null
    if (!('kind' in raw) || !['video', 'script', 'archive', 'unknown'].includes(raw.kind)) return null
    if (!('fileName' in raw) || (raw.fileName !== null && (!text(raw.fileName, 256) || /[/\\]/.test(raw.fileName)))) return null
    if (!('controlId' in raw) || (raw.controlId !== null && (!text(raw.controlId, 80) || !/^ero-\d+-\d+$/.test(raw.controlId) || url !== currentUrl))) return null
    if ('archivePasswords' in raw && (!Array.isArray(raw.archivePasswords) || raw.archivePasswords.length > 8
      || raw.archivePasswords.some((password: unknown) => !text(password, 256) || password.length === 0))) return null
    const archivePasswords = 'archivePasswords' in raw ? [...new Set<string>(raw.archivePasswords)] : undefined
    const controlId = raw.controlId
    const id = sourceId(raw.postNumber, url, controlId)
    if (seen.has(id)) continue
    seen.add(id)
    sources.push({
      id, url, label: raw.label.trim(), host: new URL(url).hostname,
      kind: raw.kind, fileName: raw.fileName, postNumber: raw.postNumber, controlId,
      mirrorKey: 'mirrorKey' in raw && text(raw.mirrorKey, 80) && new RegExp(`^post-${raw.postNumber}-mirror-[1-9]\\d*$`).test(raw.mirrorKey) ? raw.mirrorKey : null,
      ...(archivePasswords?.length ? { archivePasswords } : {}),
    })
  }
  for (const key of new Set(sources.map((source) => source.mirrorKey).filter((key): key is string => key !== null))) {
    const group = sources.filter((candidate) => candidate.mirrorKey === key)
    const first = group[0]
    const names = new Set(group.map((source) => source.fileName).filter((name) => name !== null))
    if (!first || group.length < 2 || group.length > 8 || group.some((candidate) => candidate.postNumber !== first.postNumber
      || candidate.controlId !== null || candidate.kind !== first.kind) || names.size > 1) {
      for (const source of group) source.mirrorKey = null
    }
  }
  const categories: NonNullable<EroTopic['categories']> = []
  if ('categories' in value && Array.isArray(value.categories)) {
    for (const category of value.categories.slice(0, 100)) {
      if (category && typeof category === 'object' && 'slug' in category && text(category.slug, 100)
        && /^[\w-]+$/.test(category.slug) && 'name' in category && text(category.name, 100)
        && !categories.some((known) => known.slug === category.slug)) categories.push({ slug: category.slug, name: category.name })
    }
  }
  return { tabId, generation, url: currentUrl, title: value.title, scope: 'loaded-posts', sources, categories }
}

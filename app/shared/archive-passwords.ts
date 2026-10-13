export interface ArchivePasswordBlock {
  text: string
  kind: 'heading' | 'text' | 'code'
  headingLevel?: number
  sourceIds?: readonly string[]
  literalValue?: string
  excluded?: boolean
  groupId?: string
}

export interface ArchivePasswordPost {
  authorUsername?: string
  blocks: readonly ArchivePasswordBlock[]
}

export interface ArchivePasswordSource {
  id: string
  kind: 'archive' | 'unknown' | 'script' | 'video'
  fileName?: string | null
  label?: string
  mirrorKey?: string | null
}

export interface ArchivePasswordMatch {
  sourceId: string
  candidates: string[]
}

const MAX_BLOCKS = 500
const MAX_SOURCES = 200
const MAX_BLOCK_TEXT = 8192
const MAX_CANDIDATES = 8
const MAX_PASSWORD_LENGTH = 256
const UNSUITABLE_SCOPE = /\b(?:login|log\s*in|sign\s*in|account|subscription|subscribe|patreon|paywall|provider\s+password)\b/i
const ARCHIVE_SCOPE = /\b(?:archives?|zip|unzip|funscripts?|scripts?)\b/i
const VIDEO_SCOPE = /\b(?:videos?|movies?|previews?|trailers?|audio)\b/i
const CUE = /^(?:the\s+)?(?:(archives?|zip|unzip|unpack(?:ing)?|extract(?:ion)?)\s+)?(?:password|pw)\b(?:\s+(?:for|to|of)\s+(?:the\s+)?((?:archives?|zip)(?:\s+files?)?|[^:\n]{1,120}\.(?:zip|7z|rar)))?(?:\s*(?::|=|\bis\b)\s*(.*)|\s*)$/i

interface Cue {
  blockIndex: number
  value: string
  explicitArchive: boolean
  namedArchive: string | null
}

interface Section {
  start: number
  end: number
  level: number
  parent: number | null
  text: string
}

function readCue(block: ArchivePasswordBlock, blockIndex: number): Cue | null {
  if (block.excluded || block.kind === 'code') return null
  const match = CUE.exec(block.text.trim())
  if (!match) return null
  if (block.literalValue !== undefined && (match[3] ?? '').trim()) return null
  const reference = match[2] ?? ''
  return {
    blockIndex,
    value: match[3] ?? '',
    explicitArchive: Boolean(match[1] || reference),
    namedArchive: /\.(?:zip|7z|rar)$/i.test(reference) ? reference : null,
  }
}

function sectionsFor(blocks: readonly ArchivePasswordBlock[]) {
  const sections: Section[] = [{ start: 0, end: blocks.length, level: 0, parent: null, text: '' }]
  const stack = [0]
  const blockSections: number[] = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    if (!block.excluded && block.kind === 'heading') {
      const level = block.headingLevel
      if (level !== undefined && Number.isInteger(level) && level >= 1 && level <= 6) {
        while (stack.length > 1) {
          const current = sections[stack.at(-1) ?? 0]
          if (!current || current.level < level) break
          current.end = index
          stack.pop()
        }
        const parent = stack.at(-1) ?? 0
        sections.push({ start: index, end: blocks.length, level, parent, text: block.text.trim() })
        stack.push(sections.length - 1)
      }
    }
    blockSections[index] = stack.at(-1) ?? 0
  }
  return { sections, blockSections }
}

function scopeFor(sectionId: number, sections: readonly Section[]) {
  let archive = false
  let video = false
  let unsuitable = false
  let current: number | null = sectionId
  while (current !== null) {
    const section: Section | undefined = sections[current]
    if (!section) break
    unsuitable ||= UNSUITABLE_SCOPE.test(section.text)
    archive ||= ARCHIVE_SCOPE.test(section.text)
    video ||= VIDEO_SCOPE.test(section.text) && !ARCHIVE_SCOPE.test(section.text)
    current = section.parent
  }
  return { archive, video, unsuitable }
}

function passwordValue(raw: string, block: ArchivePasswordBlock, cue: Cue, author: string | undefined): string | null {
  let value = block.kind === 'code' ? raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '') : raw.trim()
  const wrappers = [['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’']] as const
  const wrapper = block.kind === 'code' ? undefined : wrappers.find(([open, close]) => value.startsWith(open) && value.endsWith(close) && value.length >= 2)
  if (wrapper) value = value.slice(wrapper[0].length, -wrapper[1].length)
  if (!wrapper && block.kind !== 'code' && /^(?:same as\s+)?my user\s?name$/i.test(value)) {
    if (!cue.explicitArchive || !author || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,59}$/u.test(author)) return null
    return author
  }
  if (!value || value.length > MAX_PASSWORD_LENGTH || /[\u0000-\u001f\u007f]/.test(value) || /https?:\/\/|www\./i.test(value)) return null
  if (/^(?:none|not required|not set|no password|password required|see (?:above|below|post|description)|click here)$/i.test(value)) return null
  if (!wrapper && block.kind !== 'code') {
    if (/\b(?:please|contact|subscribe|login|log in|sign in|visit|check|provided|description|username is|password is)\b/i.test(value)) return null
    if (value.split(/\s+/).length > 4) return null
  }
  return value
}

function cueValue(cue: Cue, blocks: readonly ArchivePasswordBlock[], author: string | undefined) {
  const block = blocks[cue.blockIndex]
  if (!block) return null
  if (block.literalValue !== undefined) return passwordValue(block.literalValue, { ...block, kind: 'code' }, cue, author)
  if (cue.value.trim()) return passwordValue(cue.value, block, cue, author)
  const next = blocks[cue.blockIndex + 1]
  if (!next || next.excluded || next.kind === 'heading' || next.sourceIds?.length || readCue(next, cue.blockIndex + 1)) return null
  return passwordValue(next.text, next, cue, author)
}

function namedSource(source: ArchivePasswordSource, cue: Cue) {
  if (!cue.namedArchive) return true
  const name = source.fileName ?? ''
  return name === cue.namedArchive || source.label === cue.namedArchive
}

export function findArchivePasswords(post: ArchivePasswordPost, sourceList: readonly ArchivePasswordSource[]): ArchivePasswordMatch[] {
  const blocks = post.blocks.slice(0, MAX_BLOCKS).map((block) => ({ ...block, text: block.text.slice(0, MAX_BLOCK_TEXT) }))
  const sources = new Map(sourceList.slice(0, MAX_SOURCES).map((source) => [source.id, source]))
  const { sections, blockSections } = sectionsFor(blocks)
  const matches = new Map<string, string[]>()

  function eligibleIds(indices: readonly number[], cue: Cue) {
    const ids = new Set<string>()
    for (const index of indices) {
      const block = blocks[index]
      if (!block || block.excluded) continue
      const scope = scopeFor(blockSections[index] ?? 0, sections)
      if (scope.unsuitable) continue
      for (const id of block.sourceIds?.slice(0, MAX_SOURCES) ?? []) {
        const source = sources.get(id)
        if (!source || source.kind === 'video' || source.kind === 'script' || !namedSource(source, cue)) continue
        if (source.kind === 'unknown' && (scope.video || (!scope.archive && !cue.explicitArchive))) continue
        ids.add(id)
      }
    }
    return [...ids]
  }

  function sameArchive(ids: readonly string[]) {
    if (ids.length === 1) return true
    const mirrorKeys = ids.map((id) => sources.get(id)?.mirrorKey)
    return mirrorKeys.length > 0 && mirrorKeys.every((key) => typeof key === 'string' && key.length > 0 && key === mirrorKeys[0])
  }

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    const cue = readCue(block, index)
    if (!cue) continue
    const cueScope = scopeFor(blockSections[index] ?? 0, sections)
    if (cueScope.unsuitable) continue
    const value = cueValue(cue, blocks, post.authorUsername)
    if (value === null) continue
    let ids: string[] = []
    if (block.sourceIds?.length) {
      ids = eligibleIds([index], cue)
    } else if (block.groupId) {
      const candidates = eligibleIds(blocks.flatMap((item, itemIndex) => item.groupId === block.groupId ? [itemIndex] : []), cue)
      if (sameArchive(candidates)) ids = candidates
    } else {
      let sectionId: number | null = blockSections[index] ?? 0
      while (sectionId !== null) {
        const section: Section | undefined = sections[sectionId]
        if (!section || UNSUITABLE_SCOPE.test(section.text)) break
        const indices = Array.from({ length: section.end - section.start }, (_, offset) => section.start + offset)
        const candidates = eligibleIds(indices, cue)
        if (candidates.length) {
          if (sameArchive(candidates)) ids = candidates
          break
        }
        if (section.text && !CUE.test(section.text) && (section.level <= 3 || ARCHIVE_SCOPE.test(section.text) || VIDEO_SCOPE.test(section.text))) break
        sectionId = section.parent
      }
    }
    if (!cue.explicitArchive && !cueScope.archive) {
      const adjacentArchive = blocks.some((item, itemIndex) => !item.excluded && Math.abs(itemIndex - index) <= 3
        && item.sourceIds?.some((id) => ids.includes(id) && sources.get(id)?.kind === 'archive'))
      if (!adjacentArchive) continue
    }
    for (const id of ids) {
      const values = matches.get(id) ?? []
      if (!values.includes(value) && values.length < MAX_CANDIDATES) values.push(value)
      matches.set(id, values)
    }
  }
  return [...sources.keys()].flatMap((sourceId) => {
    const candidates = matches.get(sourceId)
    return candidates?.length ? [{ sourceId, candidates }] : []
  })
}

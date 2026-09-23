import { createTranslator, ENGLISH, type Translate, type MessageKey } from '@shared/i18n'
import { isAxisId } from '@shared/axes'
import { normalizeSearch, SEARCH_FIELDS, SEARCH_MAX_LENGTH, searchWords, type SearchField, type SearchInfo } from '@shared/search'

export interface TextTerm {
  kind: 'text'
  value: string
  field?: SearchField
  exact: boolean
  exclude: boolean
}
export interface FilterTerm {
  kind: 'filter'
  sql: string
  params: (string | number)[]
  label: string
  exclude: boolean
}
export type SearchTerm = TextTerm | FilterTerm
export interface SearchPlan {
  groups: SearchTerm[][]
  info: SearchInfo
}

const NUMBERS: Record<string, { sql: string; error: MessageKey }> = {
  duration: { sql: 'm.duration_ms', error: 'library.search.invalidDuration' },
  rating: { sql: 'm.rating', error: 'library.search.invalidRating' },
  plays: { sql: 'coalesce(w.play_count, 0)', error: 'library.search.invalidPlayCount' },
  speed: { sql: 'm.average_speed', error: 'library.search.invalidSpeed' },
  size: { sql: 'm.size', error: 'library.search.invalidSize' },
  resolution: { sql: 'm.height', error: 'library.search.invalidResolution' },
  added: { sql: 'm.added_at', error: 'library.search.invalidDate' },
  modified: { sql: 'm.mtime', error: 'library.search.invalidDate' },
  played: { sql: 'w.last_played', error: 'library.search.invalidDate' },
}
const FILTER_LABELS: Record<string, MessageKey> = {
  duration: 'library.search.condition.duration',
  rating: 'library.search.condition.rating',
  plays: 'library.search.condition.plays',
  speed: 'library.search.condition.speed',
  size: 'library.search.condition.size',
  resolution: 'library.search.condition.resolution',
  added: 'library.search.condition.added',
  modified: 'library.search.condition.modified',
  played: 'library.search.condition.played',
  codec: 'library.search.condition.codec',
  type: 'library.search.condition.type',
  script: 'library.search.condition.script',
}
const FIELD_ERRORS: Record<SearchField, MessageKey> = {
  title: 'library.search.invalidTitle',
  performer: 'library.search.invalidPerformer',
  tag: 'library.search.invalidTag',
  description: 'library.search.invalidDescription',
  studio: 'library.search.invalidStudio',
  folder: 'library.search.invalidFolder',
  filename: 'library.search.invalidFilename',
  playlist: 'library.search.invalidPlaylist',
  source: 'library.search.invalidSource',
  script: 'library.search.invalidScript',
}
const HAS_SCRIPT = 'EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id)'
const RESOLUTIONS: Record<string, number> = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160, '8k': 4320 }
const COMPARATORS: Record<string, string> = { under: '<', below: '<', over: '>', above: '>' }

function numeric(field: string, input: string): { sql: string; params: number[] } | null {
  const spec = NUMBERS[field]
  if (!spec) return null
  const [, compare = '=', raw = ''] = input.match(/^(<=|>=|<|>|=)?(.+)$/) ?? []
  let value = NaN
  if (['added', 'modified', 'played'].includes(field)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      value = Date.parse(`${raw}T00:00:00`)
      if (Number.isFinite(value) && new Date(value).getDate() !== Number(raw.slice(-2))) value = NaN
      if (Number.isFinite(value) && value > 0) {
        const next = new Date(value)
        next.setDate(next.getDate() + 1)
        if (compare === '=') return { sql: `(${spec.sql} >= ? AND ${spec.sql} < ?)`, params: [value, next.getTime()] }
        if (compare === '<=') return { sql: `(${spec.sql} > 0 AND ${spec.sql} < ?)`, params: [next.getTime()] }
        if (compare === '>') return { sql: `(${spec.sql} >= ?)`, params: [next.getTime()] }
      }
    }
  } else {
    const match = raw.match(/^(\d+(?:\.\d+)?)([a-z]*)$/i)
    if (match) {
      const n = Number(match[1])
      const unit = (match[2] ?? '').toLowerCase()
      const units: Record<string, number> = field === 'duration'
        ? { '': 60_000, ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000 }
        : field === 'size' ? { '': 1, b: 1, kb: 1000, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }
          : field === 'resolution' ? { '': 1, p: 1 } : { '': 1 }
      if (units[unit] !== undefined) value = n * units[unit]
    }
    const resolution = RESOLUTIONS[raw.toLowerCase()]
    if (field === 'resolution' && resolution) value = resolution
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (field === 'rating' && value > 5)) return null
  const known = ['duration', 'size', 'resolution', 'added', 'modified', 'played'].includes(field) ? `${spec.sql} > 0 AND ` : ''
  return { sql: `(${known}${spec.sql} ${compare} ?)`, params: [value] }
}

export function parseSearch(query: string, t: Translate = createTranslator('en', ENGLISH)): SearchPlan {
  const info: SearchInfo = { query, conditions: [], corrections: [] }
  const groups: SearchTerm[][] = [[]]
  const fail = (error: string): SearchPlan => ({ groups: [], info: { ...info, error } })
  if (query.length > SEARCH_MAX_LENGTH) return fail(t('library.search.searchTooLong'))
  const tokens = query.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/gu) ?? []
  if (tokens.length > 32) return fail(t('library.search.tooManyTerms'))
  if (tokens.join('').replace(/\s/g, '') !== query.replace(/\s/g, '')) return fail(t('library.search.unclosedQuote'))
  const add = (term: SearchTerm) => {
    groups[groups.length - 1]!.push(term)
    if (term.kind === 'filter') info.conditions.push(term.exclude ? t('library.search.notCondition', { condition: term.label }) : term.label)
  }
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i]!
    if (token === 'OR') {
      if (!groups[groups.length - 1]!.length || i === tokens.length - 1) return fail(t('library.search.incompleteOr'))
      groups.push([])
      continue
    }
    if (token === 'AND') {
      if (!groups[groups.length - 1]!.length || i === tokens.length - 1 || ['OR', 'AND'].includes(tokens[i + 1]!)) return fail(t('library.search.incompleteAnd'))
      continue
    }
    const exclude = token.startsWith('-') && token.length > 1
    if (exclude) token = token.slice(1)
    const quoted = token.includes('"')
    const lower = token.toLowerCase()
    if (!quoted && COMPARATORS[lower] && /^\d+(?:\.\d+)?(?:[a-z]+)?$/i.test(tokens[i + 1] ?? '')) {
      let amount = tokens[++i]!
      let labelAmount = amount
      if (/^\d+(?:\.\d+)?$/.test(amount) && /^(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)$/i.test(tokens[i + 1] ?? '')) {
        const unit = tokens[++i]!
        labelAmount = `${amount} ${unit}`
        amount += unit
      }
      const parsed = numeric('duration', COMPARATORS[lower] + amount)
      if (!parsed) return fail(t('library.search.invalidDuration'))
      add({ kind: 'filter', ...parsed, label: t(COMPARATORS[lower] === '<' ? 'library.search.under' : 'library.search.over', { amount: labelAmount }), exclude })
      continue
    }
    if (!quoted && /^(with|without)$/.test(lower) && /^scripts?$/i.test(tokens[i + 1] ?? '')) {
      i++
      add({ kind: 'filter', sql: lower === 'with' ? HAS_SCRIPT : `NOT ${HAS_SCRIPT}`, params: [], label: lower === 'with' ? t('library.search.hasScript') : t('library.search.missingScript'), exclude })
      continue
    }
    const simple: Record<string, [string, string]> = {
      unwatched: ['coalesce(w.play_count, 0) = 0', t('library.filter.unwatched')], watched: ['coalesce(w.play_count, 0) > 0', t('library.filter.watched')],
      favourites: ['m.favourite = 1', t('library.section.favourites')], favorites: ['m.favourite = 1', t('library.section.favourites')],
      scripted: [HAS_SCRIPT, t('library.search.hasScript')], unscripted: [`NOT ${HAS_SCRIPT}`, t('library.search.missingScript')],
      vr: ["m.projection != 'flat'", 'VR'], '2d': ["m.projection = 'flat'", '2D'],
      pinned: ['m.pinned > 0', t('media.pinned')],
      continue: ['v.position_ms > 0 AND v.position_ms < m.duration_ms - 5000', t('library.section.continueWatching')],
    }
    if (!quoted && simple[lower]) {
      const [sql, label] = simple[lower]
      add({ kind: 'filter', sql, params: [], label, exclude })
      continue
    }
    if (!quoted && RESOLUTIONS[lower]) {
      add({ kind: 'filter', sql: 'm.height >= ?', params: [RESOLUTIONS[lower]], label: lower.toUpperCase(), exclude })
      continue
    }
    const fieldMatch = token.match(/^([a-z]+):(.*)$/i)
    const field = fieldMatch?.[1]?.toLowerCase()
    const value = (fieldMatch?.[2] ?? (token.startsWith('#') ? token.slice(1) : token)).replace(/"/g, '').replace(/\\(.)/g, '$1')
    const lowerValue = value.toLowerCase()
    if (field && NUMBERS[field]) {
      const parsed = numeric(field, value)
      if (!parsed) return fail(t(NUMBERS[field].error))
      add({ kind: 'filter', ...parsed, label: t(FILTER_LABELS[field]!, { value }), exclude })
    } else if (field === 'axis') {
      const axis = value.toUpperCase()
      if (!isAxisId(axis)) return fail(t('library.search.invalidAxis'))
      add({ kind: 'filter', sql: 'EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis = ?)', params: [axis], label: axis, exclude })
    } else if (field === 'codec' || field === 'type' || field === 'script' && ['any', 'missing', 'multi', 'stroke', 'estim'].includes(lowerValue)) {
      let sql: string
      let params: string[] = []
      if (field === 'codec') {
        if (!value) return fail(t('library.search.invalidCodec'))
        sql = 'lower(m.codec) = ?'
        params = [({ h265: 'hevc', h264: 'h264', avc: 'h264' } as Record<string, string>)[value.toLowerCase()] ?? value.toLowerCase()]
      } else if (field === 'type') {
        if (!['vr', '2d'].includes(value.toLowerCase())) return fail(t('library.search.invalidType'))
        sql = value.toLowerCase() === 'vr' ? "m.projection != 'flat'" : "m.projection = 'flat'"
      } else {
        sql = lowerValue === 'missing' ? `NOT ${HAS_SCRIPT}` : lowerValue === 'multi' ? '(SELECT count(*) FROM scripts s WHERE s.media_id = m.id) >= 2'
          : lowerValue === 'stroke' ? "EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis = 'L0')"
            : lowerValue === 'estim' ? "EXISTS (SELECT 1 FROM scripts s WHERE s.media_id = m.id AND s.axis IN ('EA','EB','EV','E1','E2','E3','E4'))" : HAS_SCRIPT
      }
      add({ kind: 'filter', sql, params, label: t(FILTER_LABELS[field]!, { value }), exclude })
    } else {
      const textField = SEARCH_FIELDS.find((f) => f === field) ?? (token.startsWith('#') ? 'tag' : undefined)
      const text = normalizeSearch(field && !textField ? token : value)
      if (textField && !text) return fail(t(FIELD_ERRORS[textField]))
      if (searchWords(text).length === 0) continue
      add({ kind: 'text', value: text, field: textField, exact: quoted || textField !== undefined || exclude, exclude })
    }
  }
  if (query.trim() && groups.every((g) => g.length === 0)) return fail(t('library.search.noSearchTerms'))
  return { groups, info }
}

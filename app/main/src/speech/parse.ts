import { textChips, type Chip, type ChipAlt } from '@shared/portals'
import type { SpeechWord } from '@shared/speech'
import { spellingDistance } from '../library/search-index'

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

function below100(ws: readonly string[], i: number): [number, number] | null {
  const w = ws[i] ?? ''
  const tens = TENS[w]
  if (tens !== undefined) {
    const unit = UNITS[ws[i + 1] ?? '']
    return unit !== undefined && unit > 0 && unit < 10 ? [tens + unit, 2] : [tens, 1]
  }
  const unit = UNITS[w]
  return unit === undefined ? null : [unit, 1]
}

function numberAt(ws: readonly string[], i: number): [number, number] | null {
  const first = below100(ws, i)
  if (!first) return null
  let [n, len] = first
  if (ws[i + len] === 'hundred') {
    n *= 100
    len++
    const and = ws[i + len] === 'and' ? 1 : 0
    const rest = below100(ws, i + len + and)
    if (rest) { n += rest[0]; len += and + rest[1] }
  }
  return [n, len]
}

export function voiceWords(text: string): string[] {
  const ws = text.toLowerCase().replace(/['’]/g, '').replace(/(\d)(\p{L})/gu, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!
    const next = ws[i + 1]
    if (w === 'v' && next === 'r') { out.push('vr'); i++; continue }
    if ((w === '2' || w === 'two') && next === 'd') { out.push('2d'); i++; continue }
    if (/^favou?rites?$/.test(w)) { out.push('favourites'); continue }
    const n = numberAt(ws, i)
    if (n && /^min/.test(ws[i + n[1]] ?? '')) { out.push(String(n[0])); i += n[1] - 1; continue }
    out.push(w)
  }
  return out.filter((w, i) => w !== out[i - 1])
}

const tagKey = (name: string) => name.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
const display = (w: string) => (w === 'vr' ? 'VR' : w === '2d' ? '2D' : w)

export function voiceChips(words: readonly string[], tags: readonly string[]): { chips: Chip[]; words: SpeechWord[] } {
  const known = new Map(tags.map((t) => [tagKey(t), t]))
  const filter = words.map(() => false)
  const chips = textChips(words.join(' '), tags, 'v').map((c): Chip => {
    const at = Number(c.id.slice(1))
    const tag = c.kind === 'text' ? known.get(c.label) : undefined
    const span = tag !== undefined ? c.label.split(' ').length
      : c.kind === 'text' ? 0
      : c.kind === 'under' || c.kind === 'over' ? 3
      : c.kind === 'tag' ? tagKey(c.label).split(' ').length + 1
      : 1
    for (let i = at; i < at + span; i++) filter[i] = true
    return tag === undefined ? c : { id: c.id, kind: 'tag', label: tag }
  })
  return { chips, words: words.map((w, i) => ({ text: display(w), filter: filter[i]! })) }
}

const MAX_ALTS = 3
const GRAMMAR: ChipAlt[] = [{ kind: 'fastest', label: 'Fastest' }, { kind: 'fav', label: 'Favourites' }]

export function withAlts(chips: readonly Chip[], corrections: readonly { from: string; to: string }[], tags: readonly string[]): Chip[] {
  return chips.map((c) => {
    if (c.kind !== 'text') return c
    const words = c.label.split(' ')
    const max = c.label.length >= 8 ? 2 : 1
    const found: (ChipAlt & { distance: number })[] = []
    const add = (alt: ChipAlt, distance: number) => {
      if (alt.label !== c.label && !found.some((f) => f.kind === alt.kind && f.label === alt.label)) found.push({ ...alt, distance })
    }
    const padded = ` ${c.label} `
    for (const tag of tags) {
      const key = tagKey(tag)
      const distance = spellingDistance(c.label, key, max)
      if (distance <= max) add({ kind: 'tag', label: tag }, distance)
      else if (padded.includes(` ${key} `)) add({ kind: 'tag', label: tag }, words.length - key.split(' ').length)
    }
    if (words.length === 1) {
      for (const alt of GRAMMAR) {
        const distance = spellingDistance(c.label, alt.label.toLowerCase(), 2)
        if (distance <= 2) add(alt, distance)
      }
    }
    for (const { from, to } of corrections) {
      if (!words.includes(from)) continue
      add({ kind: 'text', label: words.map((w) => (w === from ? to : w)).join(' ') }, spellingDistance(from, to, 2))
    }
    const alts = found.sort((a, b) => a.distance - b.distance || Number(a.kind === 'text') - Number(b.kind === 'text'))
      .slice(0, MAX_ALTS).map(({ distance: _d, ...alt }) => alt)
    return alts.length ? { ...c, unsure: true, alts } : c
  })
}

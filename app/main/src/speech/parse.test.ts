import { describe, expect, it } from 'vitest'
import { voiceChips, voiceWords, withAlts } from './parse'

const TAGS = ['Beach', 'Sunset Glow', 'POV']
const chips = (text: string) => voiceChips(voiceWords(text), TAGS).chips.map(({ kind, label, n }) => (n === undefined ? { kind, label } : { kind, label, n }))

describe('voiceWords', () => {
  it.each([
    ['VR under twenty minutes.', 'vr under 20 minutes'],
    ['Over twenty-five minutes', 'over 25 minutes'],
    ['under one hundred and five mins', 'under 105 mins'],
    ['under 20-minute', 'under 20 minute'],
    ['Two D, favorites!', '2d favourites'],
    ['2-D favourite', '2d favourites'],
    ['2 d', '2d'],
    ['V.R. fastest', 'vr fastest'],
    ['v r', 'vr'],
    ["Let's see one piece", 'lets see one piece'],
    ['VR VR VR VR under twenty', 'vr under twenty'],
  ])('%s', (text, words) => {
    expect(voiceWords(text).join(' ')).toBe(words)
  })
})

describe('voiceChips', () => {
  it('reads the grammar as typed search does', () => {
    expect(chips('VR under twenty minutes, fastest.')).toEqual([
      { kind: 'vr', label: 'VR' },
      { kind: 'under', label: 'Under 20 minutes', n: 20 },
      { kind: 'fastest', label: 'Fastest' },
    ])
  })

  it('reads a known tag with or without the word tag, by its exact name', () => {
    expect(chips('beach tag')).toEqual([{ kind: 'tag', label: 'Beach' }])
    expect(chips('sunset glow')).toEqual([{ kind: 'tag', label: 'Sunset Glow' }])
    expect(chips('pov in VR')).toEqual([{ kind: 'tag', label: 'POV' }, { kind: 'vr', label: 'VR' }])
    expect(chips('beach party')).toEqual([{ kind: 'text', label: 'beach party' }])
  })

  it('marks the words inside filters', () => {
    const { words } = voiceChips(voiceWords('show me sunset glow tag over 10 minutes beach party in VR'), TAGS)
    expect(words.filter((w) => w.filter).map((w) => w.text)).toEqual(['sunset', 'glow', 'tag', 'over', '10', 'minutes', 'VR'])
    expect(words.map((w) => w.text).join(' ')).toBe('show me sunset glow tag over 10 minutes beach party in VR')
  })

  it('hears nothing in nothing', () => {
    expect(voiceChips(voiceWords(' . '), TAGS)).toEqual({ chips: [], words: [] })
  })
})

describe('withAlts', () => {
  it('offers close tags and the search corrections, closest first, and marks the chip unsure', () => {
    const tags = ['Lighthouse', 'Leech', 'Beach', 'Bechdel']
    const [chip] = withAlts(voiceChips(voiceWords('beech'), tags).chips, [{ from: 'beech', to: 'beach' }, { from: 'beech', to: 'beeches' }], tags)
    expect(chip).toMatchObject({ kind: 'text', label: 'beech', unsure: true })
    expect(chip?.alts).toEqual([{ kind: 'tag', label: 'Leech' }, { kind: 'tag', label: 'Beach' }, { kind: 'text', label: 'beach' }])
  })

  it('replaces only the corrected word of a run', () => {
    const [chip] = withAlts([{ id: 'v0', kind: 'text', label: 'sunny beech day' }], [{ from: 'beech', to: 'beach' }], [])
    expect(chip?.alts).toEqual([{ kind: 'text', label: 'sunny beach day' }])
  })

  it('offers a tag that is some of the words', () => {
    const [chip] = withAlts(voiceChips(voiceWords('Beach tug.'), TAGS).chips, [], TAGS)
    expect(chip).toEqual({ id: 'v0', kind: 'text', label: 'beach tug', unsure: true, alts: [{ kind: 'tag', label: 'Beach' }] })
  })

  it('offers a misheard grammar word as its filter', () => {
    const [chip] = withAlts(voiceChips(voiceWords('Festist.'), TAGS).chips, [], TAGS)
    expect(chip).toEqual({ id: 'v0', kind: 'text', label: 'festist', unsure: true, alts: [{ kind: 'fastest', label: 'Fastest' }] })
  })

  it('leaves sure chips and filters alone', () => {
    const input = [{ id: 'v0', kind: 'vr' as const, label: 'VR' }, { id: 'v1', kind: 'text' as const, label: 'lighthouse' }]
    expect(withAlts(input, [], TAGS)).toEqual(input)
  })
})

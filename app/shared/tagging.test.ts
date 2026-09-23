import { describe, expect, it } from 'vitest'
import { parseTagList, selectTags } from './tagging'

const CSV = `tag_id,name,category,count
9999999,general,9,1
470575,1girl,0,5
13197,long_hair,0,3
385430,hatsune_miku,4,2
1234,^_^,0,1
`

describe('parseTagList', () => {
  it('keeps one entry per row in file order', () => {
    expect(parseTagList(CSV)).toEqual([
      { name: 'general', category: 9 },
      { name: '1girl', category: 0 },
      { name: 'long_hair', category: 0 },
      { name: 'hatsune_miku', category: 4 },
      { name: '^_^', category: 0 },
    ])
  })
})

describe('selectTags', () => {
  const tags = parseTagList(CSV)

  it('keeps general tags over the threshold in any still, most confident first', () => {
    const stills = [
      [0.99, 0.5, 0.95, 0.99, 0.1],
      [0.99, 0.85, 0.2, 0.99, 0.1],
    ]
    expect(selectTags(tags, stills)).toEqual(['long hair', '1girl'])
  })

  it('drops ratings, characters and anything under the threshold', () => {
    expect(selectTags(tags, [[0.99, 0.79, 0.3, 0.99, 0.5]])).toEqual([])
  })

  it('asks for less confidence the more stills a tag is in', () => {
    const two = [
      [0, 0.8, 0.8, 0, 0],
      [0, 0.8, 0.1, 0, 0],
    ]
    expect(selectTags(tags, two)).toEqual(['1girl'])
    const five = Array.from({ length: 5 }, () => [0, 0.6, 0.6, 0, 0])
    five[4] = [0, 0.6, 0.59, 0, 0]
    expect(selectTags(tags, five)).toEqual(['1girl'])
  })

  it('leaves kaomoji tags alone', () => {
    expect(selectTags(tags, [[0, 0, 0, 0, 0.9]])).toEqual(['^_^'])
  })
})

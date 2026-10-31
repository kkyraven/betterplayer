import { expect, it } from 'vitest'
import { searchSettings } from './search'

it.each([
  ['Scripts only', 'Videos without a script'],
  ['Turn off AI', 'Videos without a script'],
  ['PMV', 'Music videos'],
  ['Cock hero', 'Music videos'],
])('finds %s on AI tracking', (query, label) => {
  expect(searchSettings(query)).toContainEqual(expect.objectContaining({ page: 'tracking', label, advanced: false }))
})

import { expect, it } from 'vitest'
import { clickTag, retargetTags } from './tagFilter'

it('plain click shows only that tag, and again clears it', () => {
  const only = clickTag({ tags: ['a', 'b'], notTags: ['c'], type: 'vr' }, 'b', 'only')
  expect(only).toEqual({ tags: ['b'], notTags: undefined, type: 'vr' })
  expect(clickTag(only, 'b', 'only')).toMatchObject({ tags: undefined, notTags: undefined })
})

it('shift adds and alt excludes, each toggling and moving a tag between the two', () => {
  let f = clickTag({}, 'a', 'add')
  f = clickTag(f, 'b', 'exclude')
  expect(f).toEqual({ tags: ['a'], notTags: ['b'] })
  expect(clickTag(f, 'a', 'exclude')).toEqual({ tags: undefined, notTags: ['b', 'a'] })
  expect(clickTag(f, 'b', 'add')).toEqual({ tags: ['a', 'b'], notTags: undefined })
  expect(clickTag(f, 'b', 'exclude')).toEqual({ tags: ['a'], notTags: undefined })
})

it('follows a merge in place and drops a deleted tag', () => {
  expect(retargetTags({ tags: ['a', 'b', 'c'] }, ['a', 'c'], 'b')).toEqual({ tags: ['b'], notTags: undefined })
  expect(retargetTags({ tags: ['a'], notTags: ['x'] }, ['x'], undefined)).toEqual({ tags: ['a'], notTags: undefined })
})

import { expect, it } from 'vitest'
import { parseGroupMsg, parseSharedVideo, WATCH_GROUP_LIMIT } from './together'

const video = { id: 'offer', hash: 'a'.repeat(64), name: 'video.mp4', size: 4_000_000_000 }
it('allows large video offers but rejects paths, invalid hashes and unsafe sizes', () => {
  expect(parseSharedVideo(video)).toEqual(video)
  for (const invalid of [{ name: '../video.mp4' }, { name: 'C:\\video.mp4' }, { name: 'a\u0000.mp4' }, { hash: 'bad' }, { size: -1 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: 0 }]) expect(parseSharedVideo({ ...video, ...invalid })).toBeNull()
})

it('limits rosters and strips fields which members do not need', () => {
  const member = { friend: { id: 'guest', name: 'Guest', code: 'AAAA-BBBB', email: 'private@example.com' }, status: 'connected', missing: false, note: null }
  const parsed = parseGroupMsg({ t: 'members', members: [member] })
  expect(JSON.stringify(parsed)).not.toContain('private@example.com')
  expect(parseGroupMsg({ t: 'members', members: [member, member] })).toBeNull()
  expect(parseGroupMsg({ t: 'members', members: Array.from({ length: WATCH_GROUP_LIMIT + 1 }, (_, i) => ({ ...member, friend: { ...member.friend, id: `guest-${i}` } })) })).toBeNull()
})

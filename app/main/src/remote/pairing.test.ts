import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEST_PROTOCOL } from '@shared/quest'
import { QuestPairing, readPairRequest, readProbe } from './pairing'

describe('QuestPairing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-pairing-'))
  afterEach(() => rmSync(join(dir, 'pairing.json'), { force: true }))

  it('keeps its id and paired headsets across restarts, and only the token gets in', async () => {
    const file = join(dir, 'pairing.json')
    const first = new QuestPairing(file)
    let token = ''
    const requestId = first.request({ id: 'h1', name: 'Quest 3', pin: '0420' }, '192.168.1.24', (_status, body) => (token = (body as { token: string }).token))
    expect(first.pin(requestId!, '0420')).toBe('paired')
    const again = new QuestPairing(file)
    expect(again.id).toBe(first.id)
    expect(again.headsetFor(`Bearer ${token}`)).toEqual({ id: 'h1', name: 'Quest 3' })
    expect(again.headsetFor('Bearer nope')).toBeNull()
    expect(again.headsets()).toEqual([{ id: 'h1', name: 'Quest 3', host: null, looking: false, paired: true }])
  })

  it('nudges a paired headset at its last IPv4 address only while it is not heard, across restarts', () => {
    const file = join(dir, 'pairing.json')
    const first = new QuestPairing(file)
    const requestId = first.request({ id: 'h1', name: 'Quest 3', pin: '0420' }, '192.168.1.24', () => {})
    first.pin(requestId!, '0420')
    first.heard({ id: 'h1', name: 'Quest 3', v: QUEST_PROTOCOL }, '192.168.1.66', 23554)
    expect(first.quietHosts(Date.now() + 60_000)).toEqual([])
    first.used({ id: 'h1', name: 'Quest 3' }, '192.168.1.24')
    expect(first.quietHosts()).toEqual([])
    expect(first.quietHosts(Date.now() + 60_000)).toEqual(['192.168.1.24'])
    first.used({ id: 'h1', name: 'Quest 3' }, 'fe80::1')
    expect(new QuestPairing(file).quietHosts()).toEqual(['192.168.1.24'])
  })

  it('names the side to update for a headset on another protocol', () => {
    expect(readProbe('{"id":"h1","name":"Quest 3"}')).toEqual({ id: 'h1', name: 'Quest 3', v: 2 })
    const pairing = new QuestPairing()
    pairing.heard({ id: 'old', name: 'Old', v: QUEST_PROTOCOL - 1 }, '192.168.1.24', 23554)
    pairing.heard({ id: 'new', name: 'New', v: QUEST_PROTOCOL + 1 }, '192.168.1.25', 23554)
    pairing.heard({ id: 'same', name: 'Same', v: QUEST_PROTOCOL }, '192.168.1.26', 23554)
    expect(Object.fromEntries(pairing.headsets().map((h) => [h.id, h.update]))).toEqual({ old: 'headset', new: 'desktop', same: undefined })
  })

  it('offers a headset still probing after its first, until it uses a token here', () => {
    const pairing = new QuestPairing()
    const probe = { id: 'h1', name: 'Quest 3', v: QUEST_PROTOCOL }
    const looking = () => pairing.headsets()[0]?.looking
    pairing.heard(probe, '192.168.1.24', 23554)
    expect(looking()).toBe(false)
    pairing.heard(probe, '192.168.1.24', 23554)
    expect(looking()).toBe(true)
    pairing.used({ id: 'h1', name: 'Quest 3' }, '192.168.1.24')
    expect(looking()).toBe(false)
  })

  it('answers a connect when the headset reaches this PC, and says no after the wait', async () => {
    vi.useFakeTimers()
    const pairing = new QuestPairing()
    const reached = pairing.answer('h1', 8000)
    const silent = pairing.answer('h2', 8000)
    pairing.request({ id: 'h1', name: 'Quest 3', pin: '0420' }, '192.168.1.24', () => {})
    vi.advanceTimersByTime(8000)
    expect(await reached).toBe(true)
    expect(await silent).toBe(false)
    vi.useRealTimers()
  })

  it('reads only a four digit PIN with an id', () => {
    expect(readPairRequest({ id: ' h1 ', name: 'Quest 3', pin: '0420' })).toEqual({ id: 'h1', name: 'Quest 3', pin: '0420' })
    expect(readPairRequest({ id: 'h1', pin: '420' })).toBeNull()
    expect(readPairRequest({ id: 'h1', pin: 420 })).toBeNull()
    expect(readPairRequest({ id: '', pin: '0420' })).toBeNull()
  })
})

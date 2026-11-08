import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowState } from 'bp-engine'
import type { VrDom } from '@shared/dom'
import type { QuestDomCommand } from '@shared/quest'
import type { StageWatch } from '@/dom/stage'

const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const invoke = vi.hoisted(() => vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>())
const dom = vi.hoisted(() => ({ start: vi.fn(), send: vi.fn(), halt: vi.fn(), setHeadset: vi.fn(), load: vi.fn(async () => {}), refreshAccount: vi.fn(), resume: vi.fn() }))
vi.mock('@/ipc', () => ({
  invoke,
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
}))
vi.mock('./dom', async () => ({
  useDom: (await import('zustand')).create(() => ({ running: false, ...dom })),
  headsetDom: (s: { running: boolean }): VrDom => ({ doms: [{ id: 'd', name: 'Vale' }], session: s.running ? { name: 'Vale', line: null, said: 0, replies: [], thinking: false, level: null } : null, note: null }),
}))
vi.mock('./follow', async () => ({ useFollow: (await import('zustand')).create(() => ({ kind: 'quest', host: QUEST, state: null, matched: null, halted: null })) }))
vi.mock('./account', async () => ({ isSubscriber: (s: { subscribed?: boolean }) => s.subscribed === true, useAccount: (await import('zustand')).create(() => ({ subscribed: false })) }))
vi.mock('@/engine/client', () => ({ engine: { resumeSensation: dom.resume } }))
vi.mock('./settings', async () => ({ useSettings: (await import('zustand')).create(() => ({ settings: null })) }))
vi.mock('./player', async () => ({ usePlayer: (await import('zustand')).create(() => ({ path: null, pause: vi.fn() })) }))

const QUEST = '192.168.1.40'
const url = (id: number) => `http://192.168.1.10:8420/media/${id}`
const following = (id: number, timeMs: number, playing = true): FollowState => ({ kind: 'quest', address: `${QUEST}:23554`, status: 'connected', path: url(id), playing, timeMs, durationMs: 60_000, rate: 1 })
const noWatch: StageWatch = { ranges: () => {}, changed: () => {}, clock: () => {}, ended: () => {} }

describe('questStage', () => {
  beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval }))

  it('commands the headset and reads what it plays under the library path', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    const sent: unknown[] = []
    const stage = questStage(QUEST, (c) => sent.push(c))
    const stop = stage.watch(noWatch)
    const opened = stage.open('D:/v/Twelve.mp4', 12, { start_seconds: 30 }, new AbortController().signal)
    expect(sent).toEqual([{ kind: 'open', mediaId: 12, startMs: 30_000 }])
    useFollow.setState({ state: following(12, 30_100) })
    await opened
    expect(stage.video()).toMatchObject({ path: 'D:/v/Twelve.mp4', mediaId: 12, paused: false, timeMs: 30_100, seekGeneration: 1 })
    stage.pause()
    stage.seek(45)
    expect(sent.slice(1)).toEqual([{ kind: 'pause' }, { kind: 'seek', ms: 45_000 }])
    stop()
  })

  it('waits for the opened video, not the one it replaces', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: following(5, 59_000) })
    const stage = questStage(QUEST, () => {})
    const stop = stage.watch(noWatch)
    let done = false
    const opened = stage.open('D:/v/Twelve.mp4', 12, { start_seconds: 0 }, new AbortController().signal).then(() => (done = true))
    useFollow.setState({ state: following(5, 59_100) })
    await Promise.resolve()
    expect(done).toBe(false)
    useFollow.setState({ state: following(12, 200) })
    await opened
    stop()
  })

  it('counts an open that timed out, so the clip still ends', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: null })
    const stage = questStage(QUEST, () => {})
    const before = stage.generation()
    const opened = stage.open('D:/v/Twelve.mp4', 12, { start_seconds: 0 }, new AbortController().signal)
    vi.advanceTimersByTime(20_000)
    await opened
    expect(stage.generation()).toBeGreaterThan(before)
    vi.useRealTimers()
  })

  it('takes a new video as shown wherever the headset landed in it', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: following(5, 1000) })
    const stage = questStage(QUEST, () => {})
    const stop = stage.watch(noWatch)
    const opened = stage.open('D:/v/Twelve.mp4', 12, { start_seconds: 30 }, new AbortController().signal)
    useFollow.setState({ state: following(12, 50_000) })
    await opened
    stop()
  })

  it('puts the level back on after the wearer changes a toy', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: following(12, 1000) })
    const ranges = vi.fn()
    const stop = questStage(QUEST, () => {}).watch({ ...noWatch, ranges })
    listeners.get('headset:toys')?.({ kind: 'intensity', mediaId: 12, value: 1, host: QUEST })
    expect(ranges).toHaveBeenCalledOnce()
    stop()
  })

  it('says once when the headset reaches the end', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: following(12, 50_000) })
    const ended = vi.fn()
    const stop = questStage(QUEST, () => {}).watch({ ...noWatch, ended })
    useFollow.setState({ state: following(12, 59_900, false) })
    useFollow.setState({ state: following(12, 60_000, false) })
    expect(ended).toHaveBeenCalledOnce()
    stop()
  })

  it('reads nothing from another headset', async () => {
    const { useFollow } = await import('./follow')
    const { questStage } = await import('./questDom')
    useFollow.setState({ state: following(12, 1000), host: '192.168.1.99' })
    expect(questStage(QUEST, () => {}).video()).toBeNull()
    useFollow.setState({ host: QUEST })
  })
})

describe('startQuestDom', () => {
  const published = () => invoke.mock.calls.filter(([channel]) => channel === 'remote:dom').at(-1)
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listeners.clear()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
    invoke.mockResolvedValue(null)
    dom.start.mockResolvedValue(undefined)
  })

  const started = async () => {
    const { useDom } = await import('./dom')
    const { startQuestDom } = await import('./questDom')
    useDom.setState({ running: false })
    startQuestDom()
    listeners.get('headset:dom')?.({ kind: 'start', domId: 'd', host: QUEST })
    useDom.setState({ running: true })
    return useDom
  }

  it('starts a session for the headset that asked, and publishes its commands to it', async () => {
    await started()
    expect(dom.setHeadset).toHaveBeenCalledWith(true)
    const stage = dom.start.mock.calls[0]?.[1] as { play: () => void }
    stage.play()
    const [, state, commands, host] = published() ?? []
    expect((state as VrDom).session?.name).toBe('Vale')
    expect((commands as QuestDomCommand[]).map((c) => c.kind)).toEqual(['play'])
    expect(host).toBe(QUEST)
  })

  it('lifts the wearer\'s last Stop when they start a session', async () => {
    const { useFollow } = await import('./follow')
    useFollow.setState({ halted: { host: QUEST, path: url(5) } })
    await started()
    expect(dom.resume).toHaveBeenCalledOnce()
    expect(useFollow.getState().halted).toBeNull()
  })

  it('loads the doms only once a headset asks, and again when the account changes', async () => {
    const { useDom } = await import('./dom')
    const { useAccount } = await import('./account')
    const { startQuestDom } = await import('./questDom')
    useDom.setState({ running: false, loaded: false } as never)
    startQuestDom()
    expect(dom.load).not.toHaveBeenCalled()
    listeners.get('headset:domAsk')?.({ host: QUEST })
    expect(dom.load).toHaveBeenCalledOnce()
    useDom.setState({ loaded: true } as never)
    useAccount.setState({ subscribed: true } as never)
    expect(dom.refreshAccount).toHaveBeenCalled()
    useAccount.setState({ subscribed: false } as never)
  })

  it('halts the session on the running headset\'s Stop and bye, and no other', async () => {
    await started()
    listeners.get('headset:stop')?.({ host: '192.168.1.99' })
    expect(dom.halt).not.toHaveBeenCalled()
    listeners.get('headset:stop')?.({ host: QUEST })
    listeners.get('headset:bye')?.({ host: QUEST })
    expect(dom.halt).toHaveBeenCalledTimes(2)
  })

  it('takes words only from the headset running the session', async () => {
    await started()
    listeners.get('headset:dom')?.({ kind: 'send', text: 'Hi', host: '192.168.1.99' })
    expect(dom.send).not.toHaveBeenCalled()
    listeners.get('headset:dom')?.({ kind: 'send', text: 'Yes', host: QUEST })
    expect(dom.send).toHaveBeenCalledWith('Yes')
  })

  it('offers no doms to a headset while a session runs on this window', async () => {
    const { useDom } = await import('./dom')
    const { startQuestDom } = await import('./questDom')
    useDom.setState({ running: true })
    startQuestDom()
    expect((published()?.[1] as VrDom).doms).toEqual([])
  })

  it('lets go of the headset after a session, unless another started meanwhile', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
    const useDom = await started()
    useDom.setState({ running: false })
    useDom.setState({ running: true })
    vi.advanceTimersByTime(15_000)
    expect(published()?.[3]).toBe(QUEST)
    expect(dom.setHeadset).not.toHaveBeenCalledWith(false)
    useDom.setState({ running: false })
    vi.advanceTimersByTime(15_000)
    expect(published()?.[3]).toBeNull()
    expect(dom.setHeadset).toHaveBeenCalledWith(false)
    vi.useRealTimers()
  })

  it('halts a session whose headset never follows', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
    const { QUEST_GONE_MS } = await import('./questDom')
    const { useFollow } = await import('./follow')
    useFollow.setState({ state: null })
    await started()
    vi.advanceTimersByTime(QUEST_GONE_MS + 5_000)
    expect(dom.halt).toHaveBeenCalled()
    vi.useRealTimers()
  })
})

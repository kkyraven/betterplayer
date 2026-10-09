import { defaultAdvancedPain } from '@shared/dom-pain'
import { isFeatureName } from '@shared/usage'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultDomAi, emptyYou, newDom, type ChatMessage, type ChatReply, type ChatToolCall } from '@shared/dom'
import type { Live } from './live'
import { usePlayer } from './player'
type PlayerState = ReturnType<typeof usePlayer.getState>

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  setTags: vi.fn(),
  captureVideo: vi.fn(),
  tags: ['one', 'two', 'three', 'four'],
  tagEdits: {} as Record<number, { tags: string[]; error: boolean }>,
  applyPain: vi.fn(() => true), stopPain: vi.fn(), painState: vi.fn(() => null),
  haltSensation: vi.fn(), stopSensation: vi.fn(() => true), startSensation: vi.fn(), resetSensation: vi.fn(), clearPlaybackEnd: vi.fn(),
  open: vi.fn(), pause: vi.fn(), play: vi.fn(), seek: vi.fn(),
  replies: [] as ChatReply[],
  live: { timeMs: 0, durationMs: 120000, seekGeneration: 0, playbackEnded: false },
  path: '/one.mp4',
  paused: false,
  playerListener: null as ((s: PlayerState, prev: PlayerState) => void) | null,
  durationMs: 120000, loaded: true,
  liveListener: null as ((l: Live) => void) | null,
}))
vi.mock('@/components/player/stage', () => ({ captureVideo: m.captureVideo }))
vi.mock('@/ipc', () => ({ invoke: m.invoke }))
vi.mock('@/engine/client', () => ({ engine: { haltSensation: m.haltSensation, applyPain: m.applyPain, stopPain: m.stopPain, painState: m.painState, stopSensation: m.stopSensation, startSensation: m.startSensation, resetSensation: m.resetSensation, clearPlaybackEnd: m.clearPlaybackEnd, state: () => ({ seekGeneration: m.live.seekGeneration }) } }))
vi.mock('@/dom/level', () => ({ applyLevel: vi.fn(), reapplyRanges: vi.fn(), releaseLevel: vi.fn() }))
vi.mock('./account', () => ({ isFree: () => false, isPremium: () => true, useAccount: { getState: () => ({}) } }))
vi.mock('./library', () => ({ useLibrary: { getState: () => ({ tagEdits: m.tagEdits, setTags: m.setTags }) } }))
vi.mock('./devices', () => ({ outputName: () => 'Toy', useDevices: { getState: () => ({ outputs: [] }) } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({
  get: () => m.live,
  subscribe: (listener: (l: Live) => void) => { m.liveListener = listener; return () => { m.liveListener = null } },
}))
vi.mock('./player', () => ({
  END_WINDOW_MS: 1000,
  onPlayback: () => () => {},
  usePlayer: {
    subscribe: (listener: (s: PlayerState, prev: PlayerState) => void) => { m.playerListener = listener; return () => { m.playerListener = null } },
    getState: () => ({
      path: m.path, title: 'One', media: { id: 1 }, snapshot: { loaded: m.loaded, paused: m.paused, durationMs: m.durationMs, rate: 1 },
      open: m.open, pause: m.pause, play: m.play, seek: m.seek,
    }),
  },
}))
vi.mock('./settings', () => ({ useSettings: { subscribe: () => () => {} } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: vi.fn() }) } }))

import { useDom } from './dom'

const call = (name: string, args: Record<string, unknown>): ChatToolCall => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (...toolCalls: ChatToolCall[]): ChatReply => ({ content: '', toolCalls })
const chatMessages = (): ChatMessage[][] => m.invoke.mock.calls.filter(([channel]) => channel === 'dom:chat').map(([, messages]) => messages)
const results = () => chatMessages().flat().filter((message) => message.role === 'tool').map((message) => message.content).join('\n')
const tick = (timeMs: number, seekGeneration = m.live.seekGeneration) => {
  m.live.timeMs = timeMs
  const sample = { ...m.live, seekGeneration }
  m.liveListener?.(sample as Live)
}
const settle = async () => { await vi.waitFor(() => expect(useDom.getState().thinking).toBe(false)) }
const start = async (...calls: ChatToolCall[]) => {
  m.replies.push(reply(...calls), reply())
  await useDom.getState().start('dom')
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.clearAllMocks()
  m.replies = []
  m.captureVideo.mockReturnValue({ url: 'data:image/jpeg;base64,ZmFrZQ==', timeMs: 12345, path: '/one.mp4' })
  m.tags = ['one', 'two', 'three', 'four']
  m.tagEdits = {}
  m.setTags.mockImplementation(async (_id: number, tags: string[]) => { m.tags = tags })
  m.path = '/one.mp4'
  m.paused = false
  m.loaded = true
  m.durationMs = 120000
  m.live = { timeMs: 0, durationMs: 120000, seekGeneration: 0, playbackEnded: false }
  m.invoke.mockImplementation(async (channel: string, value: unknown) => {
    if (channel === 'dom:memories') return []
    if (channel === 'dom:chat') return m.replies.shift() ?? reply()
    if (channel === 'library:media') return { id: value, path: Number(value) === 1 ? '/one.mp4' : '/two.mp4', title: `Video ${value}`, durationMs: 120000, tags: m.tags }
    return null
  })
  m.open.mockImplementation(async (path: string, start: number) => { m.path = path; m.live.timeMs = start * 1000; m.live.seekGeneration++; m.live.playbackEnded = false; m.paused = false })
  m.pause.mockImplementation(() => { m.paused = true })
  useDom.setState({ doms: [newDom('dom', 0, 'Vale')], you: emptyYou(), advancedPain: defaultAdvancedPain(), ai: { ...defaultDomAi(), provider: 'own' }, running: false })
})
afterEach(() => { useDom.getState().stop(); vi.unstubAllGlobals() })

it('runs fractional sensation pauses and early starts without changing video playback', async () => {
  await start(call('stop_sensation', { seconds: 2.5 }), call('get_playback_state', {}), call('start_sensation', {}))
  expect(m.stopSensation).toHaveBeenCalledWith(2.5)
  expect(m.startSensation).toHaveBeenCalledOnce()
  expect(m.pause).not.toHaveBeenCalled()
  expect(m.play).not.toHaveBeenCalled()
  expect(results()).toContain('Sensation paused for 2.5')
})

it('counts one AI Dom session start and ignores duplicate or missing starts', async () => {
  await useDom.getState().start('missing')
  expect(m.invoke.mock.calls.filter(([channel]) => channel === 'usage:track')).toHaveLength(0)
  await start()
  await useDom.getState().start('dom')
  expect(m.invoke.mock.calls.filter(([channel]) => channel === 'usage:track')).toEqual([['usage:track', 'session.aidom']])
  expect(isFeatureName('session.aidom')).toBe(true)
  expect(isFeatureName('session.start')).toBe(true)
  expect(isFeatureName('session.unknown')).toBe(false)
})

it.each([0, -1, 30.1, '2.5', null])('rejects invalid sensation duration %s', async (seconds) => {
  await start(call('stop_sensation', { seconds }))
  expect(m.stopSensation).not.toHaveBeenCalled()
  expect(results()).toContain('at most 30')
})

it('refreshes exact video time between tool rounds', async () => {
  m.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'dom:memories') return []
    if (channel === 'dom:chat') {
      m.live.timeMs = 12345
      return m.replies.shift() ?? reply()
    }
    return null
  })
  await start(call('get_playback_state', {}))
  expect(results()).toContain('position_seconds=12.345')
  expect(chatMessages()[1]?.at(-1)?.content).toContain('position_seconds=12.345')
})

it('plays only selected ranges and advances to the queued start timestamp', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10.5, end_seconds: 20.5 }), call('queue_video', { id: 2, start_seconds: 30.25, end_seconds: 40.75 }))
  expect(m.open.mock.calls[0]?.slice(0, 2)).toEqual(['/one.mp4', 10.5])
  tick(10500)
  tick(20500)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(2))
  expect(m.open.mock.calls[1]?.slice(0, 2)).toEqual(['/two.mp4', 30.25])
  await settle()
  tick(30250)
  tick(40750)
  expect(m.pause).toHaveBeenCalledTimes(2)
  await settle()
  expect(m.paused).toBe(true)
  expect(m.open).toHaveBeenCalledTimes(2)
})

it('ignores the previous ending frame when two ranges use the same video', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10, end_seconds: 20 }), call('queue_video', { id: 1, start_seconds: 1, end_seconds: 3 }))
  tick(10000)
  tick(20000)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(2))
  await settle()
  tick(20000, 1)
  expect(m.pause).toHaveBeenCalledOnce()
  tick(1000)
  tick(3000)
  expect(m.pause).toHaveBeenCalledTimes(2)
  await settle()
})

it('requires both queue endpoints and rejects ranges outside the video', async () => {
  await start(call('queue_video', { id: 2 }), call('queue_video', { id: 2, start_seconds: 20, end_seconds: 121 }), call('get_playback_state', {}))
  expect(results()).toContain('start_seconds must')
  expect(results()).toContain('within the video duration')
  expect(results()).toContain('Nothing is queued.')
})

it('opens a video whose duration is unknown without an end boundary', async () => {
  const base = m.invoke.getMockImplementation()!
  m.invoke.mockImplementation(async (channel: string, value: unknown) => channel === 'library:media' ? { id: value, path: '/unknown.mp4', title: 'Unknown', durationMs: 0, tags: [] } : base(channel, value))
  await start(call('play_video', { id: 1, start_seconds: 12.5 }))
  expect(m.open).toHaveBeenCalledWith('/unknown.mp4', 12.5, undefined, true, expect.any(AbortSignal), undefined, undefined)
  expect(results()).toContain('to the end')
})

it('advances the secret queue at natural EOF of an unknown-duration video', async () => {
  const base = m.invoke.getMockImplementation()!
  m.invoke.mockImplementation(async (channel: string, value: unknown) => channel === 'library:media' && value === 1 ? { id: 1, path: '/unknown.mp4', title: 'Unknown', durationMs: 0, tags: [] } : base(channel, value))
  await start(call('play_video', { id: 1 }), call('queue_video', { id: 2, start_seconds: 1, end_seconds: 3 }))
  expect(chatMessages().at(-1)?.at(-1)?.content).toContain('Current playback: start_seconds=0.')
  m.live.playbackEnded = true
  tick(119000)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(2))
  expect(m.open.mock.calls[1]?.slice(0, 2)).toEqual(['/two.mp4', 1])
  await settle()
})

it('does not treat an unknown native duration as an immediate video end', async () => {
  const base = m.invoke.getMockImplementation()!
  m.invoke.mockImplementation(async (channel: string, value: unknown) => channel === 'library:media' && value === 1 ? { id: 1, path: '/unknown.mp4', title: 'Unknown', durationMs: 0, tags: [] } : base(channel, value))
  await start(call('play_video', { id: 1 }), call('queue_video', { id: 2, start_seconds: 1, end_seconds: 3 }))
  m.durationMs = 0
  m.live.durationMs = 0
  tick(0)
  expect(m.pause).not.toHaveBeenCalled()
  expect(m.open).toHaveBeenCalledOnce()
})

it('clears the native end when a range finishes without a queued replacement', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10, end_seconds: 11 }))
  m.clearPlaybackEnd.mockClear()
  tick(11000)
  await settle()
  expect(m.clearPlaybackEnd).toHaveBeenCalledOnce()
  useDom.getState().send('Continue')
  await settle()
  expect(m.open).toHaveBeenCalledOnce()
})

it('stopping a session clears its sensation envelope and cannot resume a queued video', async () => {
  await start(call('stop_sensation', { seconds: 30 }), call('queue_video', { id: 2, start_seconds: 1, end_seconds: 3 }))
  useDom.getState().stop()
  expect(m.resetSensation).toHaveBeenCalledTimes(2)
  expect(m.pause).toHaveBeenCalledOnce()
  useDom.getState().onEnded()
  expect(m.open).not.toHaveBeenCalled()
})

it('drops a queue lookup that finishes after the session stopped', async () => {
  await start(call('queue_video', { id: 2, start_seconds: 1, end_seconds: 3 }))
  let finish!: (detail: { id: number; path: string; title: string; durationMs: number }) => void
  const lookup = new Promise((resolve) => { finish = resolve })
  m.invoke.mockImplementation(async (channel: string) => channel === 'library:media' ? lookup : reply())
  useDom.getState().onEnded()
  useDom.getState().stop()
  finish({ id: 2, path: '/two.mp4', title: 'Two', durationMs: 120000 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(m.open).not.toHaveBeenCalled()
  expect(useDom.getState().running).toBe(false)
})


it('ends a fractional clip when its first completed-seek sample is already past the end', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10, end_seconds: 10.1 }))
  tick(10200)
  expect(m.pause).toHaveBeenCalledOnce()
  await settle()
  expect(m.paused).toBe(true)
})

it('advances on native range EOF when a low-fps final frame precedes the endpoint', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10, end_seconds: 10.15 }), call('queue_video', { id: 2, start_seconds: 30, end_seconds: 31 }))
  m.live.playbackEnded = true
  m.paused = true
  tick(10000)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(2))
  expect(m.open.mock.calls[1]?.slice(0, 2)).toEqual(['/two.mp4', 30])
  await settle()
})

it('advances an already-ended new file when the player snapshot arrives after live EOF', async () => {
  await start(call('play_video', { id: 1, start_seconds: 10, end_seconds: 10.15 }), call('queue_video', { id: 2, start_seconds: 30, end_seconds: 31 }))
  m.paused = true
  m.loaded = false
  m.live.durationMs = 60000
  m.live.playbackEnded = true
  tick(10000)
  expect(m.open).toHaveBeenCalledOnce()
  const prev = usePlayer.getState()
  m.loaded = true
  m.durationMs = 60000
  m.playerListener?.(usePlayer.getState(), prev)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(2))
  await settle()
})

const allowTags = () => useDom.setState({ ai: { ...useDom.getState().ai, tagEditing: true } })

it('rejects tag tools while disabled, including a model calling an unadvertised tool', async () => {
  await start(call('video_tags', { id: 1, action: 'replace', tags: ['new'] }))
  expect(m.setTags).not.toHaveBeenCalled()
  expect(results()).toContain('AI tag editing is disabled')
})

it('views all tags and adds, removes and replaces video tags', async () => {
  allowTags()
  await start(call('video_tags', { id: 1, action: 'view' }), call('video_tags', { id: 1, action: 'add', tags: [' New ', 'NEW'] }), call('video_tags', { id: 1, action: 'remove', tags: [' TWO '] }), call('video_tags', { id: 1, action: 'replace', tags: [] }))
  expect(results()).toContain('four')
  expect(m.setTags.mock.calls).toEqual([[1, ['one', 'two', 'three', 'four', 'new'], ['one', 'two', 'three', 'four']], [1, ['one', 'three', 'four', 'new'], ['one', 'two', 'three', 'four', 'new']], [1, [], ['one', 'three', 'four', 'new']]])
})

it.each([{ id: '1', action: 'view' }, { id: 1, action: 'rename' }, { id: 1, action: 'add', tags: [3] }, { id: 1, action: 'remove' }])('rejects malformed tag edits %s', async (args) => {
  allowTags()
  await start(call('video_tags', args))
  expect(m.setTags).not.toHaveBeenCalled()
})

it('preserves a pending user tag edit when adding AI tags', async () => {
  allowTags()
  m.tagEdits[1] = { tags: ['user edit'], error: false }
  await start(call('video_tags', { id: 1, action: 'add', tags: ['ai edit'] }))
  expect(m.setTags).toHaveBeenCalledWith(1, ['user edit', 'ai edit'], ['one', 'two', 'three', 'four'])
})

it.each(['disable', 'stop'])('rejects an in-flight tag lookup after %s', async (change) => {
  allowTags()
  m.invoke.mockImplementation(async (channel: string, value: unknown) => {
    if (channel === 'dom:memories') return []
    if (channel === 'dom:chat') return m.replies.shift() ?? reply()
    if (channel === 'library:media') {
      if (change === 'disable') useDom.setState({ ai: { ...useDom.getState().ai, tagEditing: false } })
      else useDom.getState().stop()
      return { id: value, tags: m.tags }
    }
    return null
  })
  await start(call('video_tags', { id: 1, action: 'replace', tags: ['ai edit'] }))
  expect(m.setTags).not.toHaveBeenCalled()
})

it('refreshes advertised tag permissions between tool rounds', async () => {
  allowTags()
  const advertised: boolean[] = []
  m.invoke.mockImplementation(async (channel: string, _messages: unknown, tools: unknown) => {
    if (channel === 'dom:memories') return []
    if (channel === 'dom:chat') {
      advertised.push((tools as { function: { name: string } }[]).some((tool) => tool.function.name === 'video_tags'))
      useDom.setState({ ai: { ...useDom.getState().ai, tagEditing: false } })
      return m.replies.shift() ?? reply()
    }
    return null
  })
  await start(call('get_playback_state', {}))
  expect(advertised).toEqual([true, false])
})

const allowView = () => useDom.setState({ ai: { ...useDom.getState().ai, viewVideo: true } })
const imageMessages = () => chatMessages().flat().filter((message) => message.role === 'user' && Array.isArray(message.content))

it('cannot capture or attach a video screenshot without the global opt-in', async () => {
  await start(call('view_video', {}))
  expect(m.captureVideo).not.toHaveBeenCalled()
  expect(imageMessages()).toEqual([])
  expect(results()).toContain('View video is disabled')
})

it('attaches an actual image part with the captured timestamp only to the next request', async () => {
  allowView()
  m.replies.push(reply(call('view_video', {})), reply(call('get_playback_state', {})), reply())
  await useDom.getState().start('dom')
  await settle()
  const captured = chatMessages()[1]?.find((message) => message.role === 'user' && Array.isArray(message.content))
  expect(captured?.content).toEqual([{ type: 'text', text: 'Video screenshot, id=1, position_seconds=12.345.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==', detail: 'auto' } }])
  expect(chatMessages()[2]?.some((message) => message.role === 'user' && Array.isArray(message.content))).toBe(false)
  expect(m.pause).not.toHaveBeenCalled()
  expect(m.seek).not.toHaveBeenCalled()
})

it('reports an unavailable video frame without attaching an image', async () => {
  allowView()
  m.captureVideo.mockReturnValue(null)
  await start(call('view_video', {}))
  expect(imageMessages()).toEqual([])
  expect(results()).toContain('No current video frame')
})

it('drops a capture when permission is disabled before its next request', async () => {
  allowView()
  m.captureVideo.mockImplementation(() => {
    useDom.setState({ ai: { ...useDom.getState().ai, viewVideo: false } })
    return { url: 'data:image/jpeg;base64,ZmFrZQ==', timeMs: 12345, path: '/one.mp4' }
  })
  await start(call('view_video', {}))
  expect(imageMessages()).toEqual([])
})

it('does not attach a frame after its session stops', async () => {
  allowView()
  m.captureVideo.mockImplementation(() => {
    useDom.getState().stop()
    return { url: 'data:image/jpeg;base64,ZmFrZQ==', timeMs: 12345, path: '/one.mp4' }
  })
  await start(call('view_video', {}))
  expect(imageMessages()).toEqual([])
})


it('advertises and applies pain only after the global opt-in, and releases it on stop', async () => {
  await start(call('apply_pain', { profile: 'whip', intensity: 5, seconds: 2.5 }))
  expect(m.applyPain).not.toHaveBeenCalled()
  expect(results()).toContain('Advanced pain is disabled')
  useDom.getState().stop()
  useDom.setState({ advancedPain: { ...defaultAdvancedPain(), enabled: true } })
  await start(call('apply_pain', { profile: 'whip', intensity: 5, seconds: 2.5 }), call('stop_pain', {}))
  expect(m.applyPain).toHaveBeenCalledWith(defaultAdvancedPain().profiles[0], 5, 2.5)
  expect(results()).toContain('Applied Whip')
  const count = m.stopPain.mock.calls.length
  useDom.getState().stop()
  expect(m.stopPain.mock.calls.length).toBe(count + 1)
})
it('rejects unknown pain profiles, invalid levels and invalid durations', async () => {
  useDom.setState({ advancedPain: { ...defaultAdvancedPain(), enabled: true } })
  await start(call('apply_pain', { profile: 'missing', intensity: 5, seconds: 2 }), call('apply_pain', { profile: 'whip', intensity: 11, seconds: 2 }), call('apply_pain', { profile: 'whip', intensity: '5', seconds: 2 }), call('apply_pain', { profile: 'whip', intensity: 5, seconds: 0 }))
  expect(m.applyPain).not.toHaveBeenCalled()
})
it('changing profiles or revoking advanced pain cancels the active override', async () => {
  useDom.setState({ advancedPain: { ...defaultAdvancedPain(), enabled: true } })
  await start(call('apply_pain', { profile: 'whip', intensity: 5, seconds: 2 }))
  const count = m.stopPain.mock.calls.length
  await useDom.getState().setAdvancedPain(defaultAdvancedPain())
  expect(m.stopPain.mock.calls.length).toBe(count + 1)
  useDom.getState().send('Again')
  m.replies.push(reply(call('apply_pain', { profile: 'whip', intensity: 5, seconds: 2 })), reply())
  await settle()
  expect(m.applyPain).toHaveBeenCalledOnce()
})


it('honors the safeword immediately while the AI is still thinking', async () => {
  let deliver: (response: ChatReply) => void = () => { throw new Error('No pending response') }
  const delayed = new Promise<ChatReply>((resolve) => { deliver = resolve })
  m.invoke.mockImplementation(async (channel: string) => channel === 'dom:chat' ? delayed : [])
  useDom.setState({ you: { ...emptyYou(), safeword: 'red' } })
  await useDom.getState().start('dom')
  expect(useDom.getState().thinking).toBe(true)
  m.resetSensation.mockClear()
  m.pause.mockClear()
  useDom.getState().send('Please, RED!')
  expect(useDom.getState().running).toBe(false)
  expect(m.pause).toHaveBeenCalled()
  expect(m.haltSensation).toHaveBeenCalledOnce()
  expect(m.haltSensation.mock.invocationCallOrder[0]).toBeLessThan(m.pause.mock.invocationCallOrder[0]!)
  expect(m.resetSensation).not.toHaveBeenCalled()
  expect(m.stopPain).toHaveBeenCalled()
  expect(chatMessages()).toHaveLength(1)
  deliver(reply(call('start_sensation', {}), call('playback', { action: 'play' })))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(m.startSensation).not.toHaveBeenCalled()
  expect(m.play).not.toHaveBeenCalled()
})
it('leaves ordinary chat running when the safeword is blank or only a substring', async () => {
  await start()
  useDom.getState().send('red')
  await settle()
  expect(useDom.getState().running).toBe(true)
  useDom.setState({ you: { ...emptyYou(), safeword: 'red' } })
  useDom.getState().send('reddish')
  await settle()
  expect(useDom.getState().running).toBe(true)
  expect(m.haltSensation).not.toHaveBeenCalled()
})

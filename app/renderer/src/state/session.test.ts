import { t } from './i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import type { MediaRow } from '@shared/library'
import { defaultSessionSetup, type SessionRun } from '@shared/session'
const m = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  time: 0,
  scale: vi.fn(() => true),
  open: vi.fn(async (_path: string, _seconds?: number) => {}),
  close: vi.fn(),
  pause: vi.fn(),
  player: { path: null as string | null, video: { axes: {} }, snapshot: { loaded: true } },
}))
vi.mock('@/ipc', () => ({ invoke: m.invoke }))
vi.mock('@/engine/client', () => ({ engine: { setOutputSessionScale: m.scale, setAxis: vi.fn() } }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./devices', () => ({ useDevices: { subscribe: vi.fn(), getState: () => ({ outputs: [{ id: 7, config: { id: 'toy-1', name: 'Toy', kind: 'serial' } }] }) } }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: m.time }) }))
vi.mock('./player', () => ({ usePlayer: { getState: () => ({ ...m.player, open: m.open, close: m.close, pause: m.pause, prepare: vi.fn(async () => {}) }) } }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ settings: null }) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({ stop: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: vi.fn(), mediaCentre: false }) } }))
import { useSession } from './session'

function row(id: number): MediaRow {
  return {
    id,
    rootId: 1,
    path: `/fictional/${id}.mp4`,
    title: `Video ${id}`,
    folder: '',
    size: 1,
    mtime: 1,
    addedAt: 1,
    durationMs: 120000,
    width: 100,
    height: 100,
    codec: 'h264',
    projection: 'flat',
    thumb: null,
    strip: null,
    axes: ['L0'],
    averageSpeed: 100,
    heat: [100],
    rating: 0,
    favourite: false,
    watchedMs: null,
    playCount: 0,
    lastPlayed: null,
    tags: [],
    pinned: false,
    hidden: false,
  }
}
function recording(): SessionRun {
  const setup = defaultSessionSetup()
  setup.toys = {
    ...setup.toys,
    enabled: true,
    rules: [{ outputId: 'toy-1', name: 'Toy', low: 0, middle: 0.5, high: 1 }],
    periods: [{ id: 'p', outputId: 'toy-1', name: 'Toy', from: 0.3, to: 0.4, scale: 0.75 }],
  }
  return {
    setup,
    totalMs: 60000,
    phases: [{ startMs: 0, endMs: 60000, from: 0, to: 1, hard: false, label: 'Ramp' }],
    clips: [
      { mediaId: 1, title: 'One', startMs: 10000, endMs: 40000, intensity: 0.25, axesOff: [], phase: 0 },
      { mediaId: 2, title: 'Two', startMs: 50000, endMs: 80000, intensity: 0.75, axesOff: [], phase: 0 },
    ],
  }
}
beforeEach(async () => {
  if (useSession.getState().stage === 'running') useSession.getState().end()
  await Promise.resolve()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  m.invoke.mockReset().mockImplementation(async (channel, value) => {
    if (channel === 'library:query') return { rows: [row(1), row(2)], total: 2 }
    if (channel === 'library:queryIds' || channel === 'session:recentMediaIds' || channel === 'session:saved' || channel === 'session:history') return []
    if (channel === 'library:media') return row(Number(value))
    if (channel === 'session:replay') return recording()
    if (channel === 'session:start' || channel === 'session:save') return 10
    return null
  })
  m.time = 0
  m.player.path = null
  m.open.mockReset().mockImplementation(async (path) => {
    m.player.path = path
  })
  m.close.mockClear()
  m.pause.mockClear()
  m.scale.mockClear()
  useSession.setState({
    setup: defaultSessionSetup(),
    stage: 'setup',
    busy: false,
    loading: false,
    error: null,
    issues: [],
    candidates: [],
    pool: [],
    plan: [],
    phases: [],
    totalMs: 0,
    activeRun: null,
    sessionId: null,
    history: [],
    saved: [],
  })
})
it('fetches every selection page, deduplicates overlaps, and queries playlists used only by a period', async () => {
  const rows = Array.from({ length: 2001 }, (_, i) => row(i + 1))
  m.invoke.mockImplementation(async (channel, value) => {
    if (channel === 'library:query') {
      const query = value as { offset: number }
      return { rows: rows.slice(query.offset, query.offset + 2000), total: rows.length }
    }
    if (channel === 'library:queryIds') return [1, 2]
    return []
  })
  useSession.setState({
    setup: {
      ...defaultSessionSetup(),
      entries: [
        { ref: { kind: 'section', section: 'all' }, role: 'include' },
        { ref: { kind: 'tag', name: 'Mix' }, role: 'include' },
      ],
      timeRules: [{ id: 'p', from: 0, to: 0.5, mode: 'prefer', match: 'any', refs: [{ kind: 'playlist', id: 3, name: 'Period only' }] }],
    },
  })
  await useSession.getState().refresh()
  expect(useSession.getState().pool).toHaveLength(2001)
  expect(useSession.getState().playlists.get(3)).toEqual(new Set([1, 2]))
  expect(m.invoke).toHaveBeenCalledWith('library:query', expect.objectContaining({ offset: 2000 }))
})
it('records before opening and applies toy rules using session time across clips, then restores output', async () => {
  await useSession.getState().replay(4)
  expect(m.invoke).toHaveBeenCalledWith('session:start', recording(), 'Session')
  expect(m.open).toHaveBeenLastCalledWith('/fictional/1.mp4', 10)
  expect(m.scale).toHaveBeenLastCalledWith(7, 0)
  useSession.getState().onTime(31000, true)
  expect(m.scale).toHaveBeenLastCalledWith(7, 0.75)
  useSession.getState().next()
  await vi.waitFor(() => expect(m.open).toHaveBeenLastCalledWith('/fictional/2.mp4', 50))
  expect(m.scale).toHaveBeenLastCalledWith(7, 0.5)
  useSession.getState().end()
  expect(m.scale).toHaveBeenLastCalledWith(7, 1)
  expect(m.pause).toHaveBeenCalled()
  expect(m.invoke).toHaveBeenCalledWith('session:finish', 10, false)
})
it('blocks missing-media replay without starting or dropping the missing clip', async () => {
  const implementation = m.invoke.getMockImplementation()!
  m.invoke.mockImplementation((channel, ...args) => (channel === 'library:media' && args[0] === 2 ? Promise.resolve(null) : implementation(channel, ...args)))
  await useSession.getState().replay(4)
  expect(useSession.getState().error).toBe(t('session.error.unavailableVideos', { count: 1 }))
  expect(m.open).not.toHaveBeenCalled()
  expect(m.invoke.mock.calls.some(([channel]) => channel === 'session:start')).toBe(false)
})
it('cancels an opening clip if the user ends the session before it finishes loading', async () => {
  let finish: () => void = () => {}
  m.open.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const replay = useSession.getState().replay(4)
  await vi.waitFor(() => expect(m.open).toHaveBeenCalled())
  useSession.getState().end()
  expect(m.close).toHaveBeenCalled()
  finish()
  await replay
  expect(useSession.getState().stage).toBe('summary')
  expect(m.invoke.mock.calls.some(([channel]) => channel === 'session:played')).toBe(false)
})

it('changes period times without refetching an unchanged selection', async () => {
  await useSession.getState().refresh()
  m.invoke.mockClear()
  useSession.getState().setSetup({ timeRules: [{ id: 'p', from: 0.1, to: 0.5, mode: 'prefer', match: 'any', refs: [{ kind: 'tag', name: 'Slow' }] }] })
  expect(m.invoke).not.toHaveBeenCalled()
  expect(useSession.getState().loading).toBe(false)
})

it('starts fresh picks from a summary instead of replaying the previous plan', async () => {
  await useSession.getState().replay(4)
  useSession.getState().end()
  await Promise.resolve()
  m.invoke.mockClear()
  await useSession.getState().start()
  expect(m.invoke).toHaveBeenCalledWith('library:query', expect.anything())
  const recorded = m.invoke.mock.calls.find(([channel]) => channel === 'session:start')?.[1] as SessionRun
  expect(recorded.clips).not.toEqual(recording().clips)
  expect(m.invoke.mock.calls.some(([channel]) => channel === 'session:replay')).toBe(false)
  useSession.getState().end()
})

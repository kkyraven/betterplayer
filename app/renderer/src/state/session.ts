import { create } from 'zustand'
import { track } from '@/state/usage'
import type { AxisId } from '@shared/axes'
import type { MediaQuery, MediaRow } from '@shared/library'
import { isPlaylist } from '@shared/library'
import {
  refKey,
  type SavedSession,
  type SessionHistory,
  type SessionRun,
  type SessionClip,
  type SessionEntry,
  type SessionPhase,
  type SessionSetup,
  type SourceRef,
} from '@shared/session'
import { sessionSetup } from '@shared/session-settings'
import { defaultAxisSettings } from '@shared/settings'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { planSession, sessionElapsedMs } from '@/session/plan'
import { intensityAt } from '@/session/pacing'
import { toyScale, type SessionIssue } from '@/session/rules'
import { useDevices } from './devices'
import { t } from './i18n'
import * as live from './live'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { useTracking } from './tracking'
import { useUi } from './ui'

export type { SessionClip as Clip } from '@shared/session'
export { sessionElapsedMs, sessionRemainingMs } from '@/session/plan'
export type SessionStage = 'setup' | 'running' | 'summary'
interface SessionState {
  setup: SessionSetup
  name: string
  candidates: MediaRow[]
  pool: MediaRow[]
  playlists: Map<number, Set<number>>
  skip: Set<number>
  loading: boolean
  busy: boolean
  error: string | null
  issues: SessionIssue[]
  plan: SessionClip[]
  phases: SessionPhase[]
  totalMs: number
  revealed: boolean
  stage: SessionStage
  index: number
  startedAt: number
  sessionId: number | null
  lastSessionId: number | null
  activeRun: SessionRun | null
  played: SessionClip[]
  saved: SavedSession[]
  history: SessionHistory[]
  setSetup: (patch: Partial<SessionSetup>) => void
  addEntry: (ref: SourceRef) => void
  updateEntry: (key: string, patch: Partial<Omit<SessionEntry, 'ref'>>) => void
  removeEntry: (key: string) => void
  refresh: () => Promise<void>
  regenerate: () => void
  reveal: () => void
  start: () => Promise<void>
  next: () => void
  previous: () => void
  end: (completed?: boolean) => void
  onTime: (timeMs: number, loaded: boolean) => void
  refreshSaved: () => Promise<void>
  save: (name: string, favourite: boolean) => Promise<boolean>
  load: (kind: 'saved' | 'history', id: number) => Promise<boolean>
  replay: (id: number) => Promise<void>
  favourite: (kind: 'saved' | 'history', id: number, favourite: boolean) => Promise<void>
  deleteSaved: (id: number) => Promise<void>
}
const PAGE_SIZE = 2000
const STORAGE_KEY = 'bp.session.setup.v2'
const POOL_KEYS: ReadonlyArray<keyof SessionSetup> = ['entries', 'scriptedOnly', 'requireAxes', 'skipLastSessions', 'skipLastWatched']
function loadSetup(): SessionSetup {
  try {
    return sessionSetup(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), t)
  } catch {
    return sessionSetup(null, t)
  }
}
function queryFor(ref: Exclude<SourceRef, { kind: 'video' }>, base: MediaQuery): MediaQuery {
  switch (ref.kind) {
    case 'folder':
      return { ...base, folder: { rootId: ref.rootId, folder: ref.folder } }
    case 'tag':
      return { ...base, filters: { ...base.filters, tag: ref.name } }
    case 'section':
      return { ...base, section: ref.section }
    case 'playlist':
      return { ...base, playlistId: ref.id }
  }
}
function holdAxes(axesOff: AxisId[]) {
  const { video } = usePlayer.getState()
  const defaults = useSettings.getState().settings?.axesDefault
  for (const id of axesOff) engine.setAxis(id, { ...(video.axes[id] ?? defaults?.[id] ?? defaultAxisSettings(id)), enabled: false })
}
const scales = new Map<number, number>()
function applyToyOutput(run: SessionRun | null, elapsedMs = 0) {
  const intensity = run ? intensityAt(run.phases, elapsedMs) : null
  for (const output of useDevices.getState().outputs) {
    const scale = run && output.config.id ? toyScale(run.setup.toys, output.config.id, elapsedMs / run.totalMs, intensity) : 1
    if (scales.get(output.id) === scale) continue
    if (!engine.setOutputSessionScale(output.id, scale)) throw new Error(t('session.error.toyOutput', { name: output.config.name ?? output.config.kind }))
    scales.set(output.id, scale)
  }
}
export const useSession = create<SessionState>()((set, get) => {
  let refreshToken = 0,
    playToken = 0,
    opening = false
  const fail = (error: unknown) => set({ error: ipcMessage(error), busy: false })
  const persist = (setup: SessionSetup) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(setup))
    } catch {
    }
    set({ setup })
  }
  const play = async (clip: SessionClip) => {
    const token = ++playToken
    opening = true
    try {
      const { activeRun, plan, index } = get()
      applyToyOutput(activeRun, sessionElapsedMs(plan, index, clip.startMs))
      await usePlayer.getState().open(clip.row.path, clip.startMs / 1000)
      if (token !== playToken || get().stage !== 'running') return
      const { sessionId } = get()
      if (sessionId !== null) await invoke('session:played', sessionId, clip.row.id, clip.startMs, clip.endMs)
      const next = plan[index + 1]
      if (next) void usePlayer.getState().prepare(next.row.path, next.row).catch(fail)
      holdAxes(clip.axesOff)
      if (!activeRun?.setup.tracking) useTracking.getState().stop()
    } catch (error) {
      if (token === playToken) {
        get().end()
        fail(error)
      }
    } finally {
      if (token === playToken) opening = false
    }
  }
  const begin = async (run: SessionRun, plan: SessionClip[], name: string) => {
    const first = plan[0]
    if (!first) return
    const sessionId = await invoke('session:start', run, name)
    refreshToken++
    set({
      plan,
      phases: run.phases,
      totalMs: run.totalMs,
      activeRun: run,
      stage: 'running',
      index: 0,
      startedAt: Date.now(),
      played: [],
      sessionId,
      lastSessionId: sessionId,
      loading: false,
    })
    track('session.start')
    await play(first)
  }
  return {
    setup: loadSetup(),
    name: t('session.defaultName'),
    candidates: [],
    pool: [],
    playlists: new Map(),
    skip: new Set(),
    loading: false,
    busy: false,
    error: null,
    issues: [],
    plan: [],
    phases: [],
    totalMs: 0,
    revealed: false,
    stage: 'setup',
    index: 0,
    startedAt: 0,
    sessionId: null,
    lastSessionId: null,
    activeRun: null,
    played: [],
    saved: [],
    history: [],
    setSetup: (patch) => {
      if (get().stage === 'running' || get().busy) return
      const next = sessionSetup({ ...get().setup, ...patch }, t)
      const needsPlaylist = next.timeRules.some((rule) => rule.refs.some((ref) => ref.kind === 'playlist' && !get().playlists.has(ref.id)))
      persist(next)
      if (POOL_KEYS.some((k) => k in patch) || needsPlaylist) void get().refresh()
      else get().regenerate()
    },
    addEntry: (ref) => {
      const { entries } = get().setup
      if (!entries.some((e) => refKey(e.ref) === refKey(ref))) get().setSetup({ entries: [...entries, { ref, role: 'include' }] })
    },
    updateEntry: (key, patch) => get().setSetup({ entries: get().setup.entries.map((e) => (refKey(e.ref) === key ? { ...e, ...patch } : e)) }),
    removeEntry: (key) => get().setSetup({ entries: get().setup.entries.filter((e) => refKey(e.ref) !== key) }),
    refresh: async () => {
      if (get().stage === 'running') return
      const token = ++refreshToken,
        { setup } = get()
      set({ loading: true, error: null })
      try {
        const base: MediaQuery = { section: 'all', sort: 'added', desc: true, filters: {}, limit: PAGE_SIZE, offset: 0 }
        const rows = new Map<number, MediaRow>(),
          playlists = new Map<number, Set<number>>(),
          skip = new Set<number>()
        const jobs: Promise<void>[] = []
        const refs = [...setup.entries.map((e) => e.ref), ...setup.timeRules.flatMap((r) => r.refs)]
        for (const id of new Set(refs.flatMap((ref) => (ref.kind === 'playlist' ? [ref.id] : []))))
          jobs.push(
            invoke('library:queryIds', { ...base, playlistId: id, limit: 0 }).then((ids) => {
              playlists.set(id, new Set(ids))
            }),
          )
        const collect = async (query: MediaQuery) => {
          let offset = 0
          do {
            const page = await invoke('library:query', { ...query, offset })
            if (token !== refreshToken) return
            for (const row of page.rows) if (!isPlaylist(row)) rows.set(row.id, row)
            offset += page.rows.length
            if (!page.rows.length || (page.total !== null && offset >= page.total) || page.rows.length < PAGE_SIZE) break
          } while (true)
        }
        for (const { ref, role } of setup.entries) {
          if (role !== 'include') continue
          if (ref.kind === 'video')
            jobs.push(
              invoke('library:media', ref.id).then((row) => {
                if (row) rows.set(row.id, row)
              }),
            )
          else jobs.push(collect(queryFor(ref, base)))
        }
        if (setup.skipLastSessions > 0)
          jobs.push(
            invoke('session:recentMediaIds', setup.skipLastSessions).then((ids) => {
              for (const id of ids) skip.add(id)
            }),
          )
        if (setup.skipLastWatched > 0)
          jobs.push(
            invoke('library:query', { ...base, sort: 'lastPlayed', filters: { watched: 'yes' }, limit: setup.skipLastWatched }).then((page) => {
              for (const row of page.rows) skip.add(row.id)
            }),
          )
        await Promise.all(jobs)
        if (token !== refreshToken) return
        set({ candidates: [...rows.values()], playlists, skip, loading: false })
        get().regenerate()
      } catch (error) {
        if (token === refreshToken) {
          set({ loading: false, plan: [], pool: [] })
          fail(error)
        }
      }
    },
    regenerate: () => {
      if (get().stage === 'running' || get().loading || get().busy) return
      const { candidates, setup, playlists, skip } = get()
      const { clips: plan, phases, totalMs, pool, issues } = planSession({ candidates, setup, playlists, skip })
      set({ plan, phases, totalMs, pool, issues, revealed: false })
    },
    reveal: () => set({ revealed: true }),
    start: async () => {
      if (get().stage === 'summary' && !get().busy) {
        set({ stage: 'setup', activeRun: null })
        await get().refresh()
      }
      const { plan, phases, totalMs, setup, name, stage, busy, loading, issues } = get()
      if (!plan.length || busy || loading || issues.length || stage === 'running') return
      set({ busy: true, error: null })
      const run: SessionRun = {
        setup: structuredClone(setup),
        clips: plan.map(({ row, ...clip }) => ({ ...clip, mediaId: row.id, title: row.title })),
        phases: structuredClone(phases),
        totalMs,
      }
      try {
        await begin(run, plan, name)
      } catch (error) {
        fail(error)
      } finally {
        set({ busy: false })
      }
    },
    next: () => {
      if (get().stage !== 'running' || opening) return
      const { plan, index, played } = get(),
        current = plan[index],
        clip = plan[index + 1]
      if (!clip) {
        get().end(true)
        return
      }
      set({ index: index + 1, played: current ? [...played, current] : played })
      void play(clip)
    },
    previous: () => {
      if (get().stage !== 'running' || opening) return
      const index = Math.max(0, get().index - 1),
        clip = get().plan[index]
      if (clip) {
        set({ index })
        void play(clip)
      }
    },
    end: (completed = false) => {
      const { stage, plan, index, played, sessionId } = get()
      if (stage !== 'running') {
        set({ stage: 'setup', activeRun: null })
        void get().refresh()
        return
      }
      playToken++
      if (opening) usePlayer.getState().close()
      opening = false
      usePlayer.getState().pause()
      useTracking.getState().stop()
      const current = plan[index]
      set({ stage: 'summary', played: current ? [...played, current] : played, sessionId: null, busy: false })
      try {
        applyToyOutput(null)
      } catch (error) {
        fail(error)
      }
      if (sessionId !== null)
        void invoke('session:finish', sessionId, completed)
          .then(() => get().refreshSaved())
          .catch(fail)
      useUi.getState().setScreen('session')
      if (useUi.getState().mediaCentre) useUi.getState().setTvTab('session')
    },
    onTime: (timeMs, loaded) => {
      const { stage, plan, index, activeRun } = get(),
        clip = plan[index]
      if (stage !== 'running' || !clip || !loaded || opening) return
      if (usePlayer.getState().path !== clip.row.path) {
        get().end()
        return
      }
      try {
        applyToyOutput(activeRun, sessionElapsedMs(plan, index, timeMs))
      } catch (error) {
        get().end()
        fail(error)
        return
      }
      if (timeMs >= clip.endMs - 50) get().next()
    },
    refreshSaved: async () => {
      try {
        const [saved, history] = await Promise.all([invoke('session:saved'), invoke('session:history')])
        set({ saved, history })
      } catch (error) {
        fail(error)
      }
    },
    save: async (name, favourite) => {
      if (get().busy) return false
      set({ busy: true, error: null })
      try {
        await invoke('session:save', name, get().activeRun?.setup ?? get().setup, favourite)
        set({ name: name.trim() })
        await get().refreshSaved()
        return true
      } catch (error) {
        fail(error)
        return false
      } finally {
        set({ busy: false })
      }
    },
    load: async (kind, id) => {
      if (get().busy || get().stage === 'running') return false
      set({ busy: true, error: null })
      try {
        const item = await invoke('session:load', kind, id)
        persist(sessionSetup(item.setup, t))
        set({ name: item.name, stage: 'setup', activeRun: null, busy: false })
        await get().refresh()
        return get().error === null
      } catch (error) {
        fail(error)
        return false
      } finally {
        set({ busy: false })
      }
    },
    replay: async (id) => {
      if (get().busy || get().stage === 'running') return
      set({ busy: true, error: null })
      try {
        const run = await invoke('session:replay', id),
          rows = new Map<number, MediaRow>()
        await Promise.all(
          [...new Set(run.clips.map((c) => c.mediaId))].map(async (id) => {
            const row = await invoke('library:media', id)
            if (row) rows.set(id, row)
          }),
        )
        const missing = run.clips.filter((c) => !rows.has(c.mediaId) || rows.get(c.mediaId)!.durationMs < c.endMs)
        if (missing.length) throw new Error(t('session.error.unavailableVideos', { count: new Set(missing.map((c) => c.mediaId)).size }))
        const plan = run.clips.map(({ mediaId, title: _title, ...clip }) => ({ ...clip, row: rows.get(mediaId)! }))
        const name = get().history.find((h) => h.id === id)?.name ?? t('session.defaultName')
        persist(run.setup)
        set({ name, issues: [], revealed: false })
        await begin(run, plan, name)
      } catch (error) {
        fail(error)
      } finally {
        set({ busy: false })
      }
    },
    favourite: async (kind, id, favourite) => {
      try {
        await invoke('session:favourite', kind, id, favourite)
        await get().refreshSaved()
      } catch (error) {
        fail(error)
      }
    },
    deleteSaved: async (id) => {
      try {
        await invoke('session:deleteSaved', id)
        await get().refreshSaved()
      } catch (error) {
        fail(error)
      }
    },
  }
})
live.subscribe((l) => useSession.getState().onTime(l.timeMs, usePlayer.getState().snapshot.loaded))
useDevices.subscribe((state, previous) => {
  if (state.outputs === previous.outputs || useSession.getState().stage !== 'running') return
  const { activeRun, plan, index } = useSession.getState()
  try {
    applyToyOutput(activeRun, sessionElapsedMs(plan, index, live.get().timeMs))
  } catch (error) {
    useSession.getState().end()
    useSession.setState({ error: ipcMessage(error) })
  }
})

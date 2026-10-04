// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { create } from 'zustand'
import {
  DOM_ENDING_MS,
  DOM_ERRORS,
  DOM_ERROR_PREFIX,
  DOM_HEARTBEAT_MS,
  DOM_MEMORY_KINDS,
  SIGNED_OUT_AL,
  clampLevel,
  domAccess,
  defaultDomAi,
  newDom,
  type ChatMessage,
  type ChatToolCall,
  type DomAccount,
  type DomAiSettings,
  type DomErrorCode,
  type DomMemory,
  type DomPose,
  type DomProfile,
  type DomVideo,
  type DomYou,
  type PleasurePain,
  defaultPleasurePain,
  emptyYou,
} from '@shared/dom'
import { isPlaylist, type MediaQuery, type MediaRow } from '@shared/library'
import { invoke } from '@/ipc'
import { applyLevel, reapplyRanges, releaseLevel } from '@/dom/level'
import { domSystemPrompt, domTools } from '@/dom/prompt'
import { isFree, isPremium, useAccount } from './account'
import { outputName, useDevices } from './devices'
import { t } from './i18n'
import * as live from './live'
import { END_WINDOW_MS, onPlayback, usePlayer } from './player'
import { useSettings } from './settings'
import { useUi } from './ui'

export type DomLine =
  | { id: number; kind: 'dom' | 'me'; text: string }
  | { id: number; kind: 'act'; icon: DomActIcon; text: string; value: string; warn?: boolean }
  | { id: number; kind: 'error'; text: string }
type LineInput = DomLine extends infer L ? (L extends DomLine ? Omit<L, 'id'> : never) : never
export type DomActIcon = 'top' | 'played' | 'paused' | 'seek' | 'level' | 'remembered' | 'forgot'


const PAUSE_SETTLE_MS = 1500
const QUIET_MS = 120_000
const MAX_ROUNDS = 4
const HISTORY = 40

interface DomState {
  doms: DomProfile[]
  loaded: boolean
  selectedId: string | null
  you: DomYou
  pleasurePain: PleasurePain
  ai: DomAiSettings
  hasKey: boolean
  account: DomAccount
  accountError: string | null
  memories: DomMemory[]
  memoriesError: string | null

  load: () => Promise<void>
  select: (id: string) => void
  create: () => Promise<void>
  save: (dom: DomProfile) => Promise<void>
  remove: (id: string) => Promise<void>
  setYou: (you: DomYou) => Promise<void>
  setPleasurePain: (pp: PleasurePain) => Promise<void>
  setAi: (patch: Partial<DomAiSettings>) => Promise<void>
  setKey: (key: string | null) => Promise<void>
  refreshAccount: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, username: string, password: string) => Promise<void>
  loginWith: (provider: 'google' | 'discord') => Promise<void>
  logout: () => Promise<void>
  loadMemories: (domId: string) => Promise<void>
  addMemory: (domId: string, kind: DomMemory['kind'], content: string) => Promise<void>
  forget: (domId: string, memoryId: string) => Promise<void>
  forgetAll: (domId: string) => Promise<void>

  running: boolean
  domId: string | null
  level: number
  held: { level: number; until: number } | null
  lines: DomLine[]
  image: string | null
  thinking: boolean
  start: (domId: string) => Promise<void>
  stop: () => void
  send: (text: string) => void
  onEnded: () => void
}

export function domErrorCode(error: unknown): DomErrorCode | null {
  const match = new RegExp(`${DOM_ERROR_PREFIX}(\\w+)`).exec(String(error))
  return DOM_ERRORS.find((c) => c === match?.[1]) ?? null
}

const ERROR_TEXT: Record<DomErrorCode, () => string> = {
  signedOut: () => t('dom.error.signedOut'),
  emailTaken: () => t('dom.error.emailTaken'),
  notSupporter: () => t('common.supporterOnly'),
  freeTimeUsed: () => t('dom.error.freeTimeUsed'),
  quota: () => t('dom.error.quota'),
  model: () => t('dom.error.model'),
  blocked: () => t('dom.error.blocked'),
  network: () => t('dom.error.network'),
  server: () => t('dom.error.server'),
}
export const domErrorText = (error: unknown) => ERROR_TEXT[domErrorCode(error) ?? 'server']()

const FATAL: ReadonlySet<DomErrorCode> = new Set(['signedOut', 'notSupporter', 'freeTimeUsed', 'quota'])

const onFreeMinutes = () => isFree(useAccount.getState())

const toVideo = (r: MediaRow): DomVideo => ({ id: r.id, title: r.title, minutes: Math.round(r.durationMs / 6000) / 10, tags: r.tags.slice(0, 3) })
const query = (q: Partial<MediaQuery>): MediaQuery => ({ section: 'all', sort: 'recommended', desc: false, filters: {}, limit: 20, offset: 0, ...q })
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const useDom = create<DomState>()((set, get) => {
  let history: ChatMessage[] = []
  let pending: string[] = []
  let queue: number[] = []
  let known: DomMemory[] = []
  let run = 0
  let lineId = 0
  let lastTurnAt = 0
  let lastImageAt = 0
  let lastPose: DomPose | null = null
  let domPausing = 0
  let opening = new AbortController()
  let endingFor: string | null = null
  let timers: number[] = []
  let heldTimer = 0
  let unsubs: Array<() => void> = []

  const dom = () => get().doms.find((d) => d.id === get().domId) ?? null
  const line = (l: LineInput) => set((s) => ({ lines: [...s.lines, { ...l, id: ++lineId } as DomLine] }))
  const act = (icon: DomActIcon, text: string, value = '', warn = false) => line({ kind: 'act', icon, text, value, warn })
  const effective = () => get().held?.level ?? get().level
  const pushLevel = () => {
    if (get().running) applyLevel(get().pleasurePain, effective())
  }
  const openVideo = async (path: string, token: number) => {
    await usePlayer.getState().open(path, 0, undefined, true, opening.signal)
    if (token === run) return true
    usePlayer.getState().pause()
    return false
  }

  const recent = () => {
    const tail = history.slice(-HISTORY)
    const first = tail.findIndex((m) => m.role === 'user')
    return first < 0 ? tail : tail.slice(first)
  }

  const room = async (): Promise<string> => {
    const p = usePlayer.getState()
    const parts: string[] = []
    if (p.path) {
      const { timeMs } = live.get()
      parts.push(`Playing "${p.title}"${p.media ? ` (id ${p.media.id})` : ''}, ${clock(timeMs)} of ${clock(p.snapshot.durationMs)}, ${p.snapshot.paused ? 'paused' : 'playing'}.`)
    } else parts.push('Nothing is playing.')
    if (get().pleasurePain.enabled) {
      const h = get().held
      parts.push(h ? `Level ${h.level}, held ${Math.max(0, Math.round((h.until - Date.now()) / 1000))} s more, then ${get().level}.` : `Level ${get().level}.`)
    }
    if (queue.length) {
      const next = await invoke('library:media', queue[0]!)
      parts.push(`You queued next: ${next ? `"${next.title}" (id ${next.id})` : 'a video that is gone'}${queue.length > 1 ? ` and ${queue.length - 1} more` : ''}.`)
    } else parts.push('Nothing is queued.')
    return parts.join(' ')
  }

  const runTool = async (call: ChatToolCall, token: number): Promise<string> => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      return 'Arguments were not valid JSON.'
    }
    const d = dom()
    if (!d) return 'No session.'
    const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : Number(args[k]))
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
    switch (call.function.name) {
      case 'top_videos': {
        const page = await invoke('library:query', query({ section: 'mostWatched', sort: 'plays', desc: true }))
        act('top', t('dom.act.top'))
        return JSON.stringify(page.rows.filter((r): r is MediaRow => !isPlaylist(r)).map(toVideo))
      }
      case 'search_videos': {
        const page = await invoke('library:query', query({ search: str('query') }))
        return JSON.stringify(page.rows.filter((r): r is MediaRow => !isPlaylist(r)).map(toVideo))
      }
      case 'play_video': {
        const detail = await invoke('library:media', num('id'))
        if (!detail) return 'No video with that id.'
        if (token !== run) return 'Stopped.'
        endingFor = null
        if (!(await openVideo(detail.path, token))) return 'Stopped.'
        const start = num('start_seconds')
        if (Number.isFinite(start) && start > 0) usePlayer.getState().seek(start)
        act('played', t('dom.act.played'), detail.title)
        return `Playing "${detail.title}".`
      }
      case 'queue_video': {
        const detail = await invoke('library:media', num('id'))
        if (!detail) return 'No video with that id.'
        queue.push(detail.id)
        return `Queued "${detail.title}". It plays when this one ends.`
      }
      case 'playback': {
        const p = usePlayer.getState()
        const action = str('action')
        if (action === 'pause') {
          if (!p.snapshot.paused) domPausing = Date.now() + 2000
          p.pause()
          act('paused', t('dom.act.domPaused'))
        } else if (action === 'play') {
          p.play()
          act('played', t('dom.act.domPlayed'))
        } else if (action === 'seek' && Number.isFinite(num('seconds'))) {
          p.seek(num('seconds'))
          act('seek', t('dom.act.seeked'), clock(num('seconds') * 1000))
        } else return 'Unknown action.'
        return 'Done.'
      }
      case 'set_level': {
        if (!get().pleasurePain.enabled) return 'Pleasure and pain is off.'
        const level = clampLevel(num('level'))
        const seconds = num('seconds')
        window.clearTimeout(heldTimer)
        if (Number.isFinite(seconds) && seconds > 0) {
          set({ held: { level, until: Date.now() + seconds * 1000 } })
          heldTimer = window.setTimeout(() => {
            set({ held: null })
            pushLevel()
          }, seconds * 1000)
          act('level', t('dom.act.level'), t('dom.act.levelHeld', { level, seconds: Math.round(seconds), base: get().level }))
        } else {
          set({ level, held: null })
          act('level', t('dom.act.level'), String(level))
        }
        pushLevel()
        return `Level ${effective()}.`
      }
      case 'remember': {
        const kind = DOM_MEMORY_KINDS.find((k) => k === str('kind')) ?? 'reaction'
        const content = str('content').trim()
        if (content.length < 5) return 'Too short to remember.'
        const same = known.find((m) => m.content.toLowerCase() === content.toLowerCase())
        if (same) return `Already remembered as ${same.id}.`
        const memory = await invoke('dom:remember', d.id, kind, content)
        known = [memory, ...known]
        set((s) => ({ memories: s.selectedId === d.id ? [memory, ...s.memories] : s.memories }))
        act('remembered', t('dom.act.remembered'), content)
        return `Remembered as ${memory.id}.`
      }
      case 'forget': {
        await invoke('dom:forget', d.id, str('id'))
        known = known.filter((m) => m.id !== str('id'))
        set((s) => ({ memories: s.memories.filter((m) => m.id !== str('id')) }))
        act('forgot', t('dom.act.forgot'))
        return 'Forgotten.'
      }
      case 'send_image': {
        lastPose = { pose: str('pose'), clothing: str('clothing'), location: str('location') }
        picture(lastPose, token)
        return 'Sending.'
      }
    }
    return 'Unknown tool.'
  }

  const picture = (pose: DomPose, token: number) => {
    const d = dom()
    if (!d || d.images.provider === 'off') return
    lastImageAt = Date.now()
    invoke('dom:image', d.id, pose).then(
      (image) => {
        if (token === run) set({ image })
      },
      (error: unknown) => {
        if (token === run) line({ kind: 'error', text: `${t('dom.error.image')} ${String(error).replace(/^Error.*?: /, '')}` })
      },
    )
  }

  const turn = async (event: string) => {
    if (!get().running) return
    if (get().thinking) {
      pending.push(event)
      return
    }
    const token = run
    const d = dom()
    if (!d) return
    set({ thinking: true })
    lastTurnAt = Date.now()
    try {
      const now = await room()
      if (token !== run) return
      history.push({ role: 'user', content: `[Now] ${now}\n${event}` })
      const toys = useDevices.getState().outputs.map((o) => outputName(o.config))
      const system: ChatMessage = { role: 'system', content: domSystemPrompt(d, get().pleasurePain, get().you, toys, known) }
      const tools = domTools(d, get().pleasurePain)
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const reply = await invoke('dom:chat', [system, ...recent()], tools, onFreeMinutes() && get().ai.provider === 'agenticlover')
        if (token !== run) return
        history.push({ role: 'assistant', content: reply.content || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) })
        if (reply.content) {
          line({ kind: 'dom', text: reply.content })
          const img = d.images
          if (img.provider !== 'off' && img.send === 'messages' && Date.now() - lastImageAt >= img.everySeconds * 1000) picture(lastPose ?? { pose: 'standing', clothing: '', location: '' }, token)
        }
        if (!reply.toolCalls.length) break
        for (const call of reply.toolCalls) {
          const result = await runTool(call, token).catch((error: unknown) => `Failed: ${String(error)}`)
          if (token !== run) return
          history.push({ role: 'tool', tool_call_id: call.id, content: result })
        }
      }
    } catch (error) {
      if (token !== run) return
      const code = domErrorCode(error) ?? 'server'
      line({ kind: 'error', text: ERROR_TEXT[code]() })
      if (FATAL.has(code)) {
        get().stop()
        if (code === 'freeTimeUsed') set((s) => ({ account: { ...s.account, freeSecondsLeft: 0 } }))
        return
      }
    } finally {
      if (token === run) set({ thinking: false })
    }
    const next = pending.splice(0)
    if (next.length && token === run) void turn(next.join('\n'))
  }

  const watch = () => {
    unsubs.push(
      usePlayer.subscribe((s, prev) => {
        if (s.video !== prev.video || s.path !== prev.path) reapplyRanges()
        if (!s.snapshot.paused || prev.snapshot.paused || !s.path) return
        if (Date.now() < domPausing) {
          domPausing = 0
          return
        }
        const path = s.path
        const token = run
        timers.push(window.setTimeout(() => {
          if (token !== run) return
          const p = usePlayer.getState()
          const atEnd = live.get().timeMs >= p.snapshot.durationMs - END_WINDOW_MS
          if (!get().running || !p.snapshot.paused || p.path !== path || atEnd) return
          act('paused', t('dom.act.paused'), '', true)
          void turn('[Event] The user paused the video.')
        }, PAUSE_SETTLE_MS))
      }),
      onPlayback((command) => {
        if (command.kind === 'play') reapplyRanges()
      }),
      useSettings.subscribe((s, prev) => {
        if (s.settings?.axesDefault !== prev.settings?.axesDefault) reapplyRanges()
      }),
      live.subscribe((l) => {
        const { path, snapshot } = usePlayer.getState()
        if (!path || !snapshot.loaded || snapshot.durationMs !== l.durationMs || endingFor === path || l.durationMs < DOM_ENDING_MS * 2) return
        if (l.durationMs - l.timeMs > DOM_ENDING_MS) return
        endingFor = path
        void turn(`[Event] The video ends in ${Math.round(DOM_ENDING_MS / 1000)} seconds. ${queue.length ? 'You already queued the next one.' : 'Nothing is queued: find the next one and queue it now.'}`)
      }),
    )
    timers.push(
      window.setInterval(() => {
        if (!get().thinking && Date.now() - lastTurnAt > QUIET_MS) void turn('[Event] It has been quiet for two minutes.')
      }, 15_000),
      window.setInterval(() => {
        if (get().ai.provider !== 'agenticlover' || !onFreeMinutes()) return
        const token = run
        invoke('dom:heartbeat', DOM_HEARTBEAT_MS / 1000).then((left) => {
          if (token !== run) return
          set((s) => ({ account: { ...s.account, freeSecondsLeft: left } }))
          if (left <= 0) {
            line({ kind: 'error', text: ERROR_TEXT.freeTimeUsed() })
            get().stop()
          }
        }, () => {})
      }, DOM_HEARTBEAT_MS),
    )
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !get().running) return
    e.preventDefault()
    e.stopImmediatePropagation()
    get().stop()
  }

  return {
    doms: [],
    loaded: false,
    selectedId: null,
    you: emptyYou(),
    pleasurePain: defaultPleasurePain(),
    ai: defaultDomAi(),
    hasKey: false,
    account: SIGNED_OUT_AL,
    accountError: null,
    memories: [],
    memoriesError: null,

    load: async () => {
      const [doms, ai, hasKey, you, pleasurePain] = await Promise.all([invoke('dom:list'), invoke('dom:ai'), invoke('dom:hasKey'), invoke('dom:you'), invoke('dom:pleasurePain')])
      set((s) => ({ doms, ai, hasKey, you, pleasurePain, loaded: true, selectedId: doms.some((d) => d.id === s.selectedId) ? s.selectedId : (doms[0]?.id ?? null) }))
      await get().refreshAccount()
    },
    select: (selectedId) => set({ selectedId, memories: [], memoriesError: null }),
    create: async () => {
      const dom = newDom(crypto.randomUUID(), Date.now(), t('dom.newName'))
      await invoke('dom:save', dom)
      set((s) => ({ doms: [...s.doms, dom], selectedId: dom.id, memories: [] }))
    },
    save: async (dom) => {
      set((s) => ({ doms: s.doms.map((d) => (d.id === dom.id ? dom : d)) }))
      await invoke('dom:save', dom)
    },
    remove: async (id) => {
      if (get().domId === id) get().stop()
      await invoke('dom:delete', id)
      set((s) => {
        const doms = s.doms.filter((d) => d.id !== id)
        return { doms, selectedId: s.selectedId === id ? (doms[0]?.id ?? null) : s.selectedId }
      })
    },
    setYou: async (you) => {
      set({ you })
      await invoke('dom:setYou', you)
    },
    setPleasurePain: async (pleasurePain) => {
      set({ pleasurePain })
      pushLevel()
      await invoke('dom:setPleasurePain', pleasurePain)
    },
    setAi: async (patch) => {
      const ai = { ...get().ai, ...patch }
      set({ ai })
      await invoke('dom:setAi', ai)
    },
    setKey: async (key) => {
      await invoke('dom:setKey', key)
      set({ hasKey: key !== null && key !== '' })
    },
    refreshAccount: async () => {
      try {
        set({ account: await invoke('dom:account', onFreeMinutes()), accountError: null })
      } catch (error) {
        set({ accountError: ERROR_TEXT[domErrorCode(error) ?? 'network']() })
      }
    },
    login: async (email, password) => {
      set({ account: await invoke('dom:login', email, password, onFreeMinutes()), accountError: null })
    },
    register: async (email, username, password) => {
      set({ account: await invoke('dom:register', email, username, password, onFreeMinutes()), accountError: null })
    },
    loginWith: async (provider) => {
      set({ account: await invoke('dom:loginWith', provider, onFreeMinutes()), accountError: null })
    },
    logout: async () => {
      get().stop()
      await invoke('dom:logout')
      set({ account: SIGNED_OUT_AL })
    },
    loadMemories: async (domId) => {
      try {
        const memories = await invoke('dom:memories', domId)
        if (get().selectedId === domId || get().domId === domId) set({ memories, memoriesError: null })
      } catch (error) {
        set({ memories: [], memoriesError: ERROR_TEXT[domErrorCode(error) ?? 'network']() })
      }
    },
    addMemory: async (domId, kind, content) => {
      const memory = await invoke('dom:remember', domId, kind, content)
      set((s) => ({ memories: [memory, ...s.memories] }))
    },
    forget: async (domId, memoryId) => {
      await invoke('dom:forget', domId, memoryId)
      set((s) => ({ memories: s.memories.filter((m) => m.id !== memoryId) }))
    },
    forgetAll: async (domId) => {
      await invoke('dom:forgetAll', domId)
      set({ memories: [] })
    },

    running: false,
    domId: null,
    level: 0,
    held: null,
    lines: [],
    image: null,
    thinking: false,
    start: async (domId) => {
      const d = get().doms.find((x) => x.id === domId)
      if (!d || get().running) return
      if (domAccess(get(), isPremium(useAccount.getState())) !== 'ok') return
      run++
      history = []
      pending = []
      queue = []
      lastPose = null
      lastImageAt = 0
      endingFor = null
      domPausing = 0
      opening = new AbortController()
      const token = run
      set({ running: true, domId, level: 0, held: null, lines: [], image: d.portrait || null, thinking: false })
      known = await invoke('dom:memories', domId).catch(() => [])
      if (token !== run) return
      pushLevel()
      watch()
      window.addEventListener('keydown', onKey, true)
      useUi.getState().setScreen('player')
      const p = usePlayer.getState()
      void turn(p.path
        ? '[Event] The session starts. Something is already playing; take over from here.'
        : '[Event] The session starts. Look at what they watch most, pick a video and start it.')
    },
    stop: () => {
      if (!get().running) return
      run++
      for (const u of unsubs) u()
      unsubs = []
      for (const id of timers) {
        window.clearInterval(id)
        window.clearTimeout(id)
      }
      timers = []
      window.clearTimeout(heldTimer)
      window.removeEventListener('keydown', onKey, true)
      opening.abort()
      releaseLevel()
      queue = []
      const p = usePlayer.getState()
      if (p.path && !p.snapshot.paused) p.pause()
      set({ running: false, thinking: false, held: null })
    },
    send: (text) => {
      const body = text.trim()
      if (!body || !get().running) return
      line({ kind: 'me', text: body })
      void turn(body)
    },
    onEnded: () => {
      if (!get().running) return
      const token = run
      const id = queue.shift()
      if (id === undefined) {
        void turn('[Event] The video ended. Nothing is queued: pick the next one and play it now.')
        return
      }
      void invoke('library:media', id).then(async (detail) => {
        if (token !== run) return
        if (!detail) return void turn('[Event] The video ended and the one you queued is gone. Pick another.')
        endingFor = null
        if (!(await openVideo(detail.path, token))) return
        act('played', t('dom.act.played'), detail.title)
        void turn(`[Event] The video ended and the one you queued started: "${detail.title}".`)
      })
    },
  }
})

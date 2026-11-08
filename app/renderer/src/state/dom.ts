// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { defaultAdvancedPain, normalizeAdvancedPain, type AdvancedPain } from '@shared/dom-pain'
import { create } from 'zustand'
import {
  DOM_ENDING_MS,
  DOM_ERRORS,
  DOM_ERROR_PREFIX,
  DOM_HEARTBEAT_MS,
  DOM_MEMORY_KINDS,
  SIGNED_OUT_AL,
  VR_DOM_SLICES,
  clampLevel,
  domAccess,
  domReplies,
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
  type OwnModels,
  type PleasurePain,
  type VrDom,
  defaultPleasurePain,
  emptyYou,
} from '@shared/dom'
import { vrAllowed } from '@shared/account'
import { isPlaylist, type MediaQuery, type MediaRow } from '@shared/library'
import { invoke } from '@/ipc'
import { applyLevel, reapplyRanges, releaseLevel } from '@/dom/level'
import { domSystemPrompt, domTools, suggestReplies } from '@/dom/prompt'
import { videoRange, type DomClip, type DomRange } from '@/dom/clips'
import { saysSafeword } from '@/dom/safeword'
import { stillFrame, windowStage, type DomStage, type StageVideo } from '@/dom/stage'
import { engine } from '@/engine/client'
import { isSubscriber, isUnsubscribed, useAccount } from './account'
import { useLibrary } from './library'
import { isEngineOutput, outputName, useDevices } from './devices'
import { t } from './i18n'
import { END_WINDOW_MS } from './player'
import { track } from './usage'

export type DomLine =
  | { id: number; kind: 'dom' | 'me'; text: string }
  | { id: number; kind: 'act'; icon: DomActIcon; text: string; value: string; warn?: boolean }
  | { id: number; kind: 'error'; text: string }
type LineInput = DomLine extends infer L ? (L extends DomLine ? Omit<L, 'id'> : never) : never
export type DomActIcon = 'top' | 'played' | 'paused' | 'seek' | 'level' | 'remembered' | 'forgot'


const PAUSE_SETTLE_MS = 1500
const QUIET_MS = 120_000
const MAX_ROUNDS = 4
type ToolResult = string | { text: string; view: ChatMessage }
const HISTORY = 40

interface DomState {
  doms: DomProfile[]
  loaded: boolean
  selectedId: string | null
  you: DomYou
  advancedPain: AdvancedPain
  setAdvancedPain: (pain: AdvancedPain) => Promise<void>
  pleasurePain: PleasurePain
  ai: DomAiSettings
  hasKey: boolean
  ownStatus: OwnModels | null
  account: DomAccount
  accountChecked: boolean
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
  checkOwn: () => Promise<void>
  refreshAccount: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, username: string, password: string) => Promise<void>
  loginWith: (provider: 'google' | 'discord') => Promise<void>
  logout: () => Promise<void>
  loadMemories: (domId: string) => Promise<void>
  addMemory: (domId: string, kind: DomMemory['kind'], content: string) => Promise<void>
  forget: (domId: string, memoryId: string) => Promise<void>
  forgetAll: (domId: string) => Promise<void>
  pullMemories: (domId: string) => Promise<DomMemory[]>
  pushMemories: (domId: string, memoryIds: string[]) => Promise<void>

  running: boolean
  domId: string | null
  level: number
  held: { level: number; until: number } | null
  lines: DomLine[]
  image: string | null
  thinking: boolean
  replies: string[]
  note: string | null
  headset: boolean
  setHeadset: (headset: boolean) => void
  start: (domId: string, stage?: DomStage) => Promise<void>
  stop: () => void
  halt: () => void
  send: (text: string) => void
  onEnded: () => void
}

export function domErrorCode(error: unknown): DomErrorCode | null {
  for (const match of String(error).matchAll(new RegExp(`${DOM_ERROR_PREFIX}(\\w+)`, 'g'))) {
    const code = DOM_ERRORS.find((c) => c === match[1])
    if (code) return code
  }
  return null
}

const ERROR_TEXT: Record<DomErrorCode, () => string> = {
  signedOut: () => t('dom.error.signedOut'),
  emailTaken: () => t('dom.error.emailTaken'),
  wrongLogin: () => t('dom.signIn.wrong'),
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

const onFreeMinutes = () => isUnsubscribed(useAccount.getState())

export function headsetDom(s: Pick<DomState, 'doms' | 'domId' | 'running' | 'lines' | 'replies' | 'note' | 'thinking' | 'level' | 'held' | 'pleasurePain' | 'ai' | 'account'>): VrDom {
  const line = [...s.lines].reverse().find((l) => l.kind === 'dom' || l.kind === 'error')
  const dom = s.doms.find((d) => d.id === s.domId)
  return {
    doms: domAccess(s, isSubscriber(useAccount.getState())) === 'ok' ? s.doms.slice(0, VR_DOM_SLICES).map(({ id, name }) => ({ id, name: name || t('dom.newName') })) : [],
    session: s.running ? { name: dom?.name || t('dom.newName'), line: line?.text ?? null, said: line?.id ?? 0, replies: s.replies, thinking: s.thinking, level: s.pleasurePain.enabled ? (s.held?.level ?? s.level) : null } : null,
    note: s.running ? null : s.note,
  }
}

const toVideo = (r: MediaRow): DomVideo => ({ id: r.id, title: r.title, minutes: Math.round(r.durationMs / 6000) / 10, duration_seconds: r.durationMs / 1000, tags: r.tags.slice(0, 3) })
const query = (q: Partial<MediaQuery>): MediaQuery => ({ section: 'all', sort: 'recommended', desc: false, filters: {}, limit: 20, offset: 0, ...q })
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const USER_HELD = 'The user has paused their toys. Sensation is off until they resume it; you cannot start or pause it.'
const TOO_LONG = 'That video is over the free length for a headset. Pick a shorter one.'

export const useDom = create<DomState>()((set, get) => {
  let history: ChatMessage[] = []
  let pending: string[] = []
  let queue: DomClip[] = []
  let clip: (DomRange & { id: number; path: string; seekGeneration: number }) | null = null
  let advancing = false
  let videoRun = 0
  let sensationResumeAt: number | null = null
  let known: DomMemory[] = []
  let run = 0
  let lineId = 0
  let lastTurnAt = 0
  let lastImageAt = 0
  let lastPose: DomPose | null = null
  let offered: string[] = []
  let stage: DomStage = windowStage
  let domPausing = 0
  let opening = new AbortController()
  let endingFor: string | null = null
  let timers: number[] = []
  let heldTimer = 0
  let unsubs: Array<() => void> = []
  let ownCheck = 0

  const dom = () => get().doms.find((d) => d.id === get().domId) ?? null
  const line = (l: LineInput) => set((s) => ({ lines: [...s.lines, { ...l, id: ++lineId } as DomLine] }))
  const act = (icon: DomActIcon, text: string, value = '', warn = false) => line({ kind: 'act', icon, text, value, warn })
  const effective = () => get().held?.level ?? get().level
  const pushLevel = () => {
    if (get().running) applyLevel(get().pleasurePain, effective())
  }
  const openVideo = async (path: string, token: number, range: DomRange & { id: number }, videoToken: number) => {
    opening.abort()
    opening = new AbortController()
    clip = null
    const seekGeneration = stage.generation()
    await stage.open(path, range.id, range, opening.signal)
    if (token === run && videoToken === videoRun && get().running) {
      clip = { ...range, path, seekGeneration }
      advancing = false
      return true
    }
    if (token !== run) stage.pause()
    return false
  }

  const recent = () => {
    const tail = history.slice(-HISTORY)
    const first = tail.findIndex((m) => m.role === 'user')
    return first < 0 ? tail : tail.slice(first)
  }

  const room = (): string => {
    const p = stage.video()
    const parts: string[] = []
    if (p) {
      const { timeMs, durationMs } = p
      parts.push(`Playing "${p.title}"${p.mediaId !== null ? ` (id ${p.mediaId})` : ''}, ${clock(timeMs)} of ${clock(durationMs)}, ${p.paused ? 'paused' : 'playing'}.`)
      parts.push(`position_seconds=${(timeMs / 1000).toFixed(3)}, duration_seconds=${(durationMs / 1000).toFixed(3)}, playback_rate=${p.rate}.`)
      if (clip?.path === p.path) parts.push(clip.end_seconds === undefined ? `Current playback: start_seconds=${clip.start_seconds}.` : `Current range: start_seconds=${clip.start_seconds}, end_seconds=${clip.end_seconds}, remaining_seconds=${Math.max(0, clip.end_seconds - timeMs / 1000).toFixed(3)}.`)
    } else parts.push('Nothing is playing.')
    const pauseLeft = sensationResumeAt === null ? 0 : sensationResumeAt - Date.now()
    if (useDevices.getState().held) parts.push(USER_HELD)
    else parts.push(pauseLeft > 0 ? `Sensation paused for ${(pauseLeft / 1000).toFixed(1)} more seconds.` : sensationResumeAt !== null && pauseLeft > -500 ? 'Sensation ramping up over 500 ms.' : 'Sensation active, subject to playback and device settings.')
    if (get().pleasurePain.enabled) {
      const h = get().held
      parts.push(h ? `Level ${h.level}, held ${Math.max(0, Math.round((h.until - Date.now()) / 1000))} s more, then ${get().level}.` : `Level ${get().level}.`)
    }
    if (get().advancedPain.enabled) {
      const pain = engine.painState()
      parts.push(pain ? `Pain profile ${JSON.stringify(pain.name)}, intensity=${pain.intensity.toFixed(2)}, remaining_seconds=${(pain.remainingMs / 1000).toFixed(2)}.` : 'No temporary pain override.')
    }
    if (queue.length) {
      parts.push(`Queued timestamp ranges in order: ${JSON.stringify(queue)}.`)
    } else parts.push('Nothing is queued.')
    return parts.join(' ')
  }

  const runTool = async (call: ChatToolCall, token: number): Promise<ToolResult> => {
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Arguments must be an object.'
      args = parsed as Record<string, unknown>
    } catch {
      return 'Arguments were not valid JSON.'
    }
    const d = dom()
    if (!d || token !== run || !get().running) return 'No session.'
    const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : Number(args[k]))
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
    switch (call.function.name) {
      case 'apply_pain': {
        if (!get().advancedPain.enabled) return 'Advanced pain is disabled.'
        const profile = get().advancedPain.profiles.find((p) => p.id === args.profile)
        if (!profile) return 'Unknown pain profile.'
        if (typeof args.intensity !== 'number' || !Number.isFinite(args.intensity) || args.intensity < 0 || args.intensity > 10 || typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds <= 0) return 'Intensity must be 0..10 and seconds must be positive.'
        if (useDevices.getState().held) return USER_HELD
        if (!engine.applyPain(profile, args.intensity, args.seconds)) return 'No connected Restim output or invalid pain profile.'
        act('level', profile.name, String(args.intensity))
        return `Applied ${profile.name} at intensity ${args.intensity} for ${args.seconds} seconds.`
      }
      case 'stop_pain': {
        if (!get().advancedPain.enabled) return 'Advanced pain is disabled.'
        engine.stopPain()
        return 'Temporary pain override stopped.'
      }
      case 'top_videos': {
        const page = await invoke('library:query', query({ section: 'mostWatched', sort: 'plays', desc: true }))
        act('top', t('dom.act.top'))
        return JSON.stringify(page.rows.filter((r): r is MediaRow => !isPlaylist(r)).map(toVideo))
      }
      case 'search_videos': {
        const page = await invoke('library:query', query({ search: str('query') }))
        return JSON.stringify(page.rows.filter((r): r is MediaRow => !isPlaylist(r)).map(toVideo))
      }
      case 'get_playback_state':
        return room()
      case 'stop_sensation': {
        const seconds = args.seconds
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30) return 'seconds must be greater than 0 and at most 30.'
        if (useDevices.getState().held) return USER_HELD
        if (!engine.stopSensation(seconds)) return 'Could not pause sensation.'
        sensationResumeAt = Date.now() + seconds * 1000
        const howl = useDevices.getState().outputs.some((o) => o.config.kind === 'howl')
        return `Sensation paused for ${seconds} seconds. It then resumes over 500 ms; the video is unaffected.${howl ? ' Howl resumes directly because it does not support output scaling.' : ''}`
      }
      case 'start_sensation': {
        if (useDevices.getState().held) return USER_HELD
        engine.startSensation()
        if (sensationResumeAt !== null && sensationResumeAt > Date.now()) sensationResumeAt = Date.now()
        const howl = useDevices.getState().outputs.some((o) => o.config.kind === 'howl')
        return `Sensation resumes over 500 ms, subject to playback and device settings.${howl ? ' Howl resumes directly because it does not support output scaling.' : ''}`
      }
      case 'view_video': {
        if (get().ai.viewVideo !== true) return 'View video is disabled.'
        const shown = await stage.frame()
        if (token !== run || !get().running) return 'No session.'
        if (get().ai.viewVideo !== true) return 'View video is disabled.'
        const open = stage.video()
        const image = shown ?? (get().headset && open ? await stillFrame(open) : null)
        if (token !== run || !get().running) return 'No session.'
        if (!image) return 'No current video frame is available. Try again once the video is displayed.'
        const p = stage.video()
        if (p?.path !== image.path) return 'The video changed. Request another screenshot.'
        const text = `Video screenshot${p.mediaId !== null ? `, id=${p.mediaId}` : ''}, position_seconds=${(image.timeMs / 1000).toFixed(3)}.`
        return { text: `${text} Attached to the next request.`, view: { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image.url, detail: 'auto' } }] } }
      }
      case 'video_tags': {
        if (get().ai.tagEditing !== true) return 'AI tag editing is disabled.'
        const id = args.id
        const action = args.action
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return 'id must be a positive integer.'
        if (!['view', 'add', 'remove', 'replace'].includes(String(action))) return 'action must be view, add, remove or replace.'
        if (action !== 'view' && (!Array.isArray(args.tags) || !args.tags.every((tag) => typeof tag === 'string'))) return 'tags must be an array of strings.'
        const video = await invoke('library:media', id)
        if (token !== run || !get().running) return 'No session.'
        if (get().ai.tagEditing !== true) return 'AI tag editing is disabled.'
        if (!video) return 'Video not found.'
        const library = useLibrary.getState()
        const current = library.tagEdits[id]?.tags ?? video.tags
        if (action === 'view') return JSON.stringify({ id, tags: current })
        const tags = [...new Set((args.tags as string[]).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
        const selection = action === 'replace' ? tags : action === 'add' ? [...new Set([...current, ...tags])] : current.filter((tag) => !tags.includes(tag))
        await library.setTags(id, selection, video.tags)
        return JSON.stringify({ id, tags: selection })
      }
      case 'play_video': {
        const videoToken = ++videoRun
        const detail = await invoke('library:media', num('id'))
        if (!detail) return 'No video with that id.'
        if (token !== run || videoToken !== videoRun) return 'Stopped.'
        if (tooLong(detail.durationMs)) return TOO_LONG
        const range = videoRange(args, detail.durationMs, false)
        if (typeof range === 'string') return range
        endingFor = null
        if (!(await openVideo(detail.path, token, { id: detail.id, ...range }, videoToken))) return 'Stopped.'
        act('played', t('dom.act.played'), detail.title)
        return range.end_seconds === undefined ? `Playing "${detail.title}" from ${range.start_seconds} seconds to the end.` : `Playing "${detail.title}" from ${range.start_seconds} to ${range.end_seconds} seconds.`
      }
      case 'queue_video': {
        const detail = await invoke('library:media', num('id'))
        if (!detail) return 'No video with that id.'
        if (token !== run) return 'Stopped.'
        if (tooLong(detail.durationMs)) return TOO_LONG
        const range = videoRange(args, detail.durationMs, true)
        if (typeof range === 'string') return range
        queue.push({ id: detail.id, ...range })
        return `Queued "${detail.title}" from ${range.start_seconds} to ${range.end_seconds} seconds. It plays when the current video or range ends.`
      }
      case 'playback': {
        const action = str('action')
        if (action === 'pause') {
          if (stage.video()?.paused === false) domPausing = Date.now() + 2000
          stage.pause()
          act('paused', t('dom.act.domPaused'))
        } else if (action === 'play') {
          stage.play()
          act('played', t('dom.act.domPlayed'))
        } else if (action === 'seek' && Number.isFinite(num('seconds'))) {
          const seconds = num('seconds')
          if (clip && (seconds < clip.start_seconds || (clip.end_seconds !== undefined && seconds >= clip.end_seconds))) return 'Seek must stay within the current timestamp range. Use play_video to choose another range.'
          stage.seek(seconds)
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
        await invoke('dom:forget', str('id'))
        known = known.filter((m) => m.id !== str('id'))
        set((s) => ({ memories: s.memories.filter((m) => m.id !== str('id')) }))
        act('forgot', t('dom.act.forgot'))
        return 'Forgotten.'
      }
      case 'suggest_replies': {
        set({ replies: domReplies(args.replies) })
        return 'Shown.'
      }
      case 'send_image': {
        lastPose = { pose: str('pose'), clothing: str('clothing'), location: str('location') }
        picture(lastPose, token)
        return 'Sending.'
      }
    }
    return 'Unknown tool.'
  }

  const tooLong = (durationMs: number) => get().headset && !vrAllowed(useAccount.getState().status.me, durationMs)

  const askReplies = async (system: ChatMessage, token: number) => {
    const reply = await invoke('dom:chat', [system, ...recent(), { role: 'user', content: '[Event] Call suggest_replies now, and say nothing.' }], [suggestReplies()], onFreeMinutes() && get().ai.provider === 'agenticlover').catch(() => null)
    if (token !== run) return
    const call = reply?.toolCalls.find((c) => c.function.name === 'suggest_replies')
    if (!call) return
    try {
      const args: unknown = JSON.parse(call.function.arguments || '{}')
      if (typeof args === 'object' && args !== null && 'replies' in args) set({ replies: domReplies(args.replies) })
    } catch {
    }
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
      const now = room()
      if (token !== run) return
      history.push({ role: 'user', content: `[Now] ${now}\n${event}` })
      const toys = useDevices.getState().outputs.filter(isEngineOutput).map((o) => outputName(o.config))
      const system: ChatMessage = { role: 'system', content: domSystemPrompt(d, get().pleasurePain, get().you, toys, known, get().headset) }
      let view: ChatMessage | null = null
      let spoke = false
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const state: ChatMessage[] = round === 0 ? [] : [{ role: 'user', content: `[Now] ${room()}` }]
        if (token !== run) return
        const tools = domTools(d, get().pleasurePain, get().ai, get().advancedPain, get().headset)
        const images: ChatMessage[] = get().ai.viewVideo === true && view ? [view] : []
        view = null
        const reply = await invoke('dom:chat', [system, ...recent(), ...images, ...state], tools, onFreeMinutes() && get().ai.provider === 'agenticlover')
        if (token !== run) return
        history.push({ role: 'assistant', content: reply.content || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) })
        if (reply.content) {
          set({ replies: [] })
          spoke = true
          line({ kind: 'dom', text: reply.content })
          const img = d.images
          if (img.provider !== 'off' && img.send === 'messages' && Date.now() - lastImageAt >= img.everySeconds * 1000) picture(lastPose ?? { pose: 'standing', clothing: '', location: '' }, token)
        }
        if (!reply.toolCalls.length) break
        for (const call of reply.toolCalls) {
          const result = await runTool(call, token).catch((error: unknown) => `Failed: ${String(error)}`)
          if (token !== run) return
          history.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : result.text })
          if (typeof result !== 'string') view = result.view
        }
        if (reply.toolCalls.every((c) => c.function.name === 'suggest_replies')) break
      }
      if (spoke && get().headset && get().replies.length === 0) await askReplies(system, token)
    } catch (error) {
      if (token !== run) return
      const code = domErrorCode(error) ?? 'server'
      const text = ERROR_TEXT[code]()
      line({ kind: 'error', text })
      if (FATAL.has(code)) {
        get().stop()
        set({ note: text })
        if (code === 'freeTimeUsed') set((s) => ({ account: { ...s.account, freeSecondsLeft: 0 } }))
        return
      }
      if (get().headset && get().replies.length === 0) set({ replies: offered })
    } finally {
      if (token === run) set({ thinking: false })
    }
    const next = pending.splice(0)
    if (next.length && token === run) void turn(next.join('\n'))
  }

  const watch = () => {
    unsubs.push(
      useDevices.subscribe((s, prev) => {
        if (s.held !== prev.held) void turn(s.held ? '[Event] The user paused their toys.' : '[Event] The user resumed their toys.')
      }),
      stage.watch({
        ranges: reapplyRanges,
        changed: (now: StageVideo | null, was: StageVideo | null) => {
          if (!advancing && now?.loaded && clip?.path === now.path && now.seekGeneration > clip.seekGeneration && now.ended) {
            get().onEnded()
            return
          }
          if (!now?.paused || !was || was.paused) return
          if (Date.now() < domPausing) {
            domPausing = 0
            return
          }
          const { path } = now
          const token = run
          timers.push(window.setTimeout(() => {
            if (token !== run) return
            const p = stage.video()
            if (!get().running || !p?.paused || p.path !== path || p.timeMs >= p.durationMs - END_WINDOW_MS) return
            act('paused', t('dom.act.paused'), '', true)
            void turn('[Event] The user paused the video.')
          }, PAUSE_SETTLE_MS))
        },
        clock: (now: StageVideo) => {
          if (advancing) return
          const { path, timeMs, durationMs } = now
          if (clip && clip.path !== path) clip = null
          if (clip && now.seekGeneration <= clip.seekGeneration) return
          const endMs = clip?.end_seconds === undefined ? durationMs : Math.min(clip.end_seconds * 1000, durationMs)
          if (clip && ((endMs > 0 && timeMs >= endMs) || now.ended)) {
            get().onEnded()
            return
          }
          const startMs = clip ? clip.start_seconds * 1000 : 0
          if (endMs <= startMs) return
          const noticeMs = Math.min(DOM_ENDING_MS, (endMs - startMs) / 2)
          if (endingFor === path || endMs - timeMs > noticeMs || now.paused) return
          endingFor = path
          void turn(`[Event] The current video or timestamp range ends in ${Math.max(0, (endMs - timeMs) / 1000).toFixed(1)} seconds. ${queue.length ? 'You already queued the next range.' : 'Nothing is queued: find the next range and queue it now.'}`)
        },
        ended: () => get().onEnded(),
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
            set({ note: ERROR_TEXT.freeTimeUsed() })
          }
        }, () => {})
      }, DOM_HEARTBEAT_MS),
    )
  }

  const stopSession = (safeword: boolean) => {
    if (!get().running) return
    if (safeword) engine.haltSensation()
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
    const open = stage.video() !== null
    if (open || stage !== windowStage) stage.pause()
    engine.stopPain()
    if (!safeword) engine.resetSensation()
    if (open) stage.clearEnd()
    if (safeword) stage.halted()
    sensationResumeAt = null
    clip = null
    advancing = false
    set({ running: false, thinking: false, held: null, replies: [] })
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
    advancedPain: defaultAdvancedPain(),
    pleasurePain: defaultPleasurePain(),
    ai: defaultDomAi(),
    hasKey: false,
    ownStatus: null,
    account: SIGNED_OUT_AL,
    accountChecked: false,
    accountError: null,
    memories: [],
    memoriesError: null,

    load: async () => {
      const [doms, ai, you, pleasurePain, advancedPain] = await Promise.all([invoke('dom:list'), invoke('dom:ai'), invoke('dom:you'), invoke('dom:pleasurePain'), invoke('dom:advancedPain')])
      const hasKey = await invoke('dom:hasKey', ai.ownUrl)
      set((s) => ({ doms, ai, hasKey, you, pleasurePain, advancedPain, loaded: true, selectedId: doms.some((d) => d.id === s.selectedId) ? s.selectedId : (doms[0]?.id ?? null) }))
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
    setAdvancedPain: async (raw) => {
      const advancedPain = normalizeAdvancedPain(raw)
      engine.stopPain()
      set({ advancedPain })
      await invoke('dom:setAdvancedPain', advancedPain)
    },
    setPleasurePain: async (pleasurePain) => {
      set({ pleasurePain })
      pushLevel()
      await invoke('dom:setPleasurePain', pleasurePain)
    },
    setAi: async (patch) => {
      const prev = get().ai
      const ai = { ...prev, ...patch }
      const moved = ai.ownUrl !== prev.ownUrl || ai.provider !== prev.provider
      if (moved) ownCheck++
      set(moved ? { ai, ownStatus: null } : { ai })
      await invoke('dom:setAi', ai)
      if (patch.ownUrl !== undefined) {
        const hasKey = await invoke('dom:hasKey', ai.ownUrl)
        if (get().ai.ownUrl === ai.ownUrl) set({ hasKey })
      }
    },
    setKey: async (key) => {
      await invoke('dom:setKey', get().ai.ownUrl, key)
      set({ hasKey: key !== null && key !== '' })
    },
    checkOwn: async () => {
      const { provider, ownUrl } = get().ai
      if (provider !== 'own') return
      const token = ++ownCheck
      const ownStatus = await invoke('dom:ownModels', ownUrl).catch((error: unknown): OwnModels => ({ kind: 'unreachable', detail: String(error) }))
      if (token === ownCheck) set({ ownStatus })
    },
    refreshAccount: async () => {
      try {
        set({ account: await invoke('dom:account', onFreeMinutes()), accountChecked: true, accountError: null })
      } catch (error) {
        set({ accountChecked: true, accountError: ERROR_TEXT[domErrorCode(error) ?? 'network']() })
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
      if (get().domId === domId) known = [memory, ...known]
      set((s) => ({ memories: [memory, ...s.memories] }))
    },
    forget: async (domId, memoryId) => {
      await invoke('dom:forget', memoryId)
      if (get().domId === domId) known = known.filter((m) => m.id !== memoryId)
      set((s) => ({ memories: s.memories.filter((m) => m.id !== memoryId) }))
    },
    forgetAll: async (domId) => {
      await invoke('dom:forgetAll', domId)
      if (get().domId === domId) known = []
      set({ memories: [] })
    },
    pullMemories: async (domId) => {
      const memories = await invoke('dom:pullMemories', domId)
      if (get().domId === domId) known = memories
      if (get().selectedId === domId) set({ memories, memoriesError: null })
      return memories.filter((m) => !m.synced)
    },
    pushMemories: async (domId, memoryIds) => {
      const memories = await invoke('dom:pushMemories', domId, memoryIds)
      if (get().domId === domId) known = memories
      if (get().selectedId === domId) set({ memories })
    },

    running: false,
    domId: null,
    level: 0,
    held: null,
    lines: [],
    image: null,
    thinking: false,
    replies: [],
    note: null,
    headset: false,
    setHeadset: (headset) => set({ headset }),
    start: async (domId, on = windowStage) => {
      const d = get().doms.find((x) => x.id === domId)
      if (!d || get().running) return
      if (domAccess(get(), isSubscriber(useAccount.getState())) !== 'ok') return
      run++
      stage = on
      history = []
      pending = []
      queue = []
      clip = null
      advancing = false
      sensationResumeAt = null
      engine.stopPain()
      engine.resetSensation()
      lastPose = null
      lastImageAt = 0
      endingFor = null
      domPausing = 0
      opening = new AbortController()
      const token = run
      offered = []
      set({ running: true, domId, level: 0, held: null, lines: [], image: d.portrait || null, thinking: false, replies: [], note: null })
      known = await invoke('dom:memories', domId).catch(() => [])
      if (token !== run) return
      track('session.aidom')
      pushLevel()
      watch()
      window.addEventListener('keydown', onKey, true)
      stage.show()
      void turn(stage.video()
        ? '[Event] The session starts. Something is already playing; take over from here.'
        : '[Event] The session starts. Look at what they watch most, pick a video and start it.')
    },
    stop: () => stopSession(false),
    halt: () => stopSession(true),
    send: (text) => {
      const body = text.trim()
      if (!body || !get().running) return
      if (get().replies.length > 0) offered = get().replies
      set({ replies: [] })
      line({ kind: 'me', text: body })
      if (saysSafeword(body, get().you.safeword)) {
        stopSession(true)
        act('paused', t('dom.you.safeword'))
        return
      }
      void turn(body)
    },
    onEnded: () => {
      if (!get().running || advancing) return
      advancing = true
      const token = run
      const videoToken = ++videoRun
      clip = null
      const path = stage.video()?.path ?? null
      domPausing = Date.now() + 2000
      stage.pause()
      stage.clearEnd()
      const next = queue.shift()
      if (!next) {
        advancing = false
        void turn('[Event] The current video or timestamp range ended. Nothing is queued: pick the next range and play it now.')
        return
      }
      void invoke('library:media', next.id).then(async (detail) => {
        if (token !== run || videoToken !== videoRun) return
        if (!detail || (stage.video()?.path ?? null) !== path) {
          advancing = false
          return void turn('[Event] The queued video is unavailable or playback changed. Pick another range.')
        }
        const range = videoRange({ ...next }, detail.durationMs, true)
        if (typeof range === 'string') {
          advancing = false
          return void turn(`[Event] The queued range is no longer valid: ${range}`)
        }
        endingFor = null
        if (!(await openVideo(detail.path, token, { id: detail.id, ...range }, videoToken))) return
        act('played', t('dom.act.played'), detail.title)
        void turn(`[Event] The queued range started: "${detail.title}", from ${range.start_seconds} to ${range.end_seconds} seconds.`)
      }).catch((error: unknown) => {
        if (token !== run || videoToken !== videoRun) return
        advancing = false
        void turn(`[Event] Could not open the queued range: ${String(error)}`)
      })
    },
  }
})

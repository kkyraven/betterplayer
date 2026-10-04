// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { AxisId } from './axes'

export const DOM_LEVEL_MAX = 15
export const DOM_FREE_SECONDS = 15 * 60
export const DOM_HEARTBEAT_MS = 60_000
export const DOM_ENDING_MS = 20_000
export const AGENTIC_LOVER_URL = 'https://agenticlover.ai/'
export const AGENTIC_LOVER_API = 'https://api.agenticlover.ai'

export const DOM_POINTS = ['C0', 'P0', 'volume'] as const
export type DomPoint = (typeof DOM_POINTS)[number]
export const DOM_SPANS = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'V0'] as const satisfies readonly AxisId[]
export type DomSpan = (typeof DOM_SPANS)[number]

export interface PainPoint {
  on: boolean
  at0: number
  at15: number
}

export interface PainSpan {
  on: boolean
  at0: [number, number]
  at15: [number, number]
}

export interface PleasurePain {
  enabled: boolean
  points: Record<DomPoint, PainPoint>
  spans: Record<DomSpan, PainSpan>
}

export const DOM_MEMORY_KINDS = ['like', 'dislike', 'reaction', 'limit'] as const
export type DomMemoryKind = (typeof DOM_MEMORY_KINDS)[number]

export interface DomMemory {
  id: string
  kind: DomMemoryKind
  content: string
  createdAt: number
}

export const IMAGE_PROVIDERS = ['off', 'comfyui', 'agenticlover'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]
export const IMAGE_SEND = ['dom', 'messages'] as const
export type ImageSend = (typeof IMAGE_SEND)[number]

export interface DomLora {
  name: string
  weight: number
}

export interface DomImages {
  provider: ImageProvider
  comfyUrl: string
  checkpoint: string
  send: ImageSend
  everySeconds: number
  appearance: string
  negative: string
  loras: DomLora[]
}

export interface DomProfile {
  id: string
  name: string
  persona: string
  portrait: string
  images: DomImages
  alPersonaId: string | null
  createdAt: number
  updatedAt: number
}

export interface DomYou {
  name: string
  petNames: string[]
  pronouns: string
  genitals: string
  kinks: string[]
  limits: string[]
}

export const emptyYou = (): DomYou => ({ name: '', petNames: [], pronouns: '', genitals: '', kinks: [], limits: [] })

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : [])

export function normalizeYou(raw: unknown): DomYou {
  if (!isRecord(raw)) return emptyYou()
  return {
    name: str(raw.name).slice(0, 100),
    petNames: strings(raw.petNames),
    pronouns: str(raw.pronouns).slice(0, 100),
    genitals: str(raw.genitals).slice(0, 100),
    kinks: strings(raw.kinks),
    limits: strings(raw.limits),
  }
}

export interface DomAiSettings {
  provider: 'agenticlover' | 'own'
  alModel: string
  ownUrl: string
  ownModel: string
}

export const defaultDomAi = (): DomAiSettings => ({ provider: 'agenticlover', alModel: '', ownUrl: 'http://127.0.0.1:1234/v1', ownModel: '' })

const point = (at0: number, at15: number, on: boolean): PainPoint => ({ on, at0, at15 })
const span = (at0: [number, number], at15: [number, number], on: boolean): PainSpan => ({ on, at0, at15 })

export function defaultPleasurePain(): PleasurePain {
  return {
    enabled: false,
    points: { C0: point(0.8, 0.2, true), P0: point(0.2, 0.55, true), volume: point(0.55, 0.88, true) },
    spans: {
      L0: span([0.3, 0.7], [0, 1], true),
      L1: span([0.4, 0.6], [0.2, 0.8], false),
      L2: span([0.4, 0.6], [0.2, 0.8], false),
      R0: span([0.45, 0.55], [0.2, 0.8], false),
      R1: span([0.45, 0.55], [0.2, 0.8], false),
      R2: span([0.45, 0.55], [0.2, 0.8], false),
      V0: span([0, 0.4], [0, 1], true),
    },
  }
}

export const defaultDomImages = (): DomImages => ({ provider: 'off', comfyUrl: 'http://127.0.0.1:8188', checkpoint: '', send: 'dom', everySeconds: 60, appearance: '', negative: '', loras: [] })

export const LORA_WEIGHT_MAX = 2

export function normalizeLoras(v: unknown): DomLora[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((l) => {
    if (!isRecord(l) || typeof l.name !== 'string' || !l.name.trim()) return []
    const w = typeof l.weight === 'number' && Number.isFinite(l.weight) ? l.weight : 1
    return [{ name: l.name.trim(), weight: Math.min(LORA_WEIGHT_MAX, Math.max(-LORA_WEIGHT_MAX, w)) }]
  })
}

export function newDom(id: string, now: number, name = ''): DomProfile {
  return { id, name, persona: '', portrait: '', images: defaultDomImages(), alPersonaId: null, createdAt: now, updatedAt: now }
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const pick = <T extends string>(options: readonly T[], v: unknown, fallback: T): T => options.find((o) => o === v) ?? fallback

function normalizeSpan(v: unknown, fallback: PainSpan): PainSpan {
  if (!isRecord(v)) return fallback
  const pair = (p: unknown, f: [number, number]): [number, number] => {
    if (!Array.isArray(p)) return f
    const a = clamp01(p[0], f[0]), b = clamp01(p[1], f[1])
    return [Math.min(a, b), Math.max(a, b)]
  }
  return { on: typeof v.on === 'boolean' ? v.on : fallback.on, at0: pair(v.at0, fallback.at0), at15: pair(v.at15, fallback.at15) }
}

export function normalizePleasurePain(raw: unknown): PleasurePain {
  const d = defaultPleasurePain()
  const pp = isRecord(raw) ? raw : {}
  const points = isRecord(pp.points) ? pp.points : {}
  const spans = isRecord(pp.spans) ? pp.spans : {}
  return {
    enabled: pp.enabled === true,
    points: Object.fromEntries(DOM_POINTS.map((k) => {
      const p = isRecord(points[k]) ? points[k] : {}
      return [k, { on: typeof p.on === 'boolean' ? p.on : d.points[k].on, at0: clamp01(p.at0, d.points[k].at0), at15: clamp01(p.at15, d.points[k].at15) }]
    })) as Record<DomPoint, PainPoint>,
    spans: Object.fromEntries(DOM_SPANS.map((k) => [k, normalizeSpan(spans[k], d.spans[k])])) as Record<DomSpan, PainSpan>,
  }
}

export function normalizeDom(raw: unknown, id: string, now: number): DomProfile {
  const base = newDom(id, now)
  if (!isRecord(raw)) return base
  const img = isRecord(raw.images) ? raw.images : {}
  return {
    id,
    name: str(raw.name).slice(0, 100),
    persona: str(raw.persona),
    portrait: str(raw.portrait),
    images: {
      provider: pick(IMAGE_PROVIDERS, img.provider, base.images.provider),
      comfyUrl: str(img.comfyUrl, base.images.comfyUrl),
      checkpoint: str(img.checkpoint),
      send: pick(IMAGE_SEND, img.send, base.images.send),
      everySeconds: typeof img.everySeconds === 'number' && img.everySeconds >= 10 ? Math.round(img.everySeconds) : base.images.everySeconds,
      appearance: str(img.appearance),
      negative: str(img.negative),
      loras: normalizeLoras(img.loras),
    },
    alPersonaId: typeof raw.alPersonaId === 'string' && raw.alPersonaId ? raw.alPersonaId : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  }
}

export const DOM_WINDOW = 0.2

export function windowAround(value: number, width = DOM_WINDOW): [number, number] {
  const lo = Math.min(1 - width, Math.max(0, value - width / 2))
  return [lo, lo + width]
}

export const clampLevel = (level: number) => Math.round(Math.min(DOM_LEVEL_MAX, Math.max(0, Number.isFinite(level) ? level : 0)))

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const pointAt = (p: PainPoint, level: number) => lerp(p.at0, p.at15, clampLevel(level) / DOM_LEVEL_MAX)

export function spanAt(s: PainSpan, level: number): [number, number] {
  const t = clampLevel(level) / DOM_LEVEL_MAX
  return [lerp(s.at0[0], s.at15[0], t), lerp(s.at0[1], s.at15[1], t)]
}

export interface PainOutput {
  points: Partial<Record<DomPoint, number>>
  spans: Partial<Record<DomSpan, [number, number]>>
}

export function painOutput(pp: PleasurePain, level: number): PainOutput {
  if (!pp.enabled) return { points: {}, spans: {} }
  const points: PainOutput['points'] = {}
  const spans: PainOutput['spans'] = {}
  for (const k of DOM_POINTS) if (pp.points[k].on) points[k] = pointAt(pp.points[k], level)
  for (const k of DOM_SPANS) if (pp.spans[k].on) spans[k] = spanAt(pp.spans[k], level)
  return { points, spans }
}

export interface DomVideo {
  id: number
  title: string
  minutes: number
  tags: string[]
}

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatReply {
  content: string
  toolCalls: ChatToolCall[]
}

export const DOM_ERRORS = ['signedOut', 'emailTaken', 'notSupporter', 'freeTimeUsed', 'quota', 'model', 'blocked', 'network', 'server'] as const
export type DomErrorCode = (typeof DOM_ERRORS)[number]
export const DOM_ERROR_PREFIX = 'dom:'

export type AlTier = 'free' | 'pro' | 'supporter_plus' | 'supporter_plus_plus'

export interface AlModel {
  id: string
  label: string
}

export interface DomAccount {
  signedIn: boolean
  email: string
  tier: AlTier
  tokensLeft: number
  resetsAt: number | null
  freeSecondsLeft: number | null
  models: AlModel[]
}

export const SIGNED_OUT_AL: DomAccount = { signedIn: false, email: '', tier: 'free', tokensLeft: 0, resetsAt: null, freeSecondsLeft: null, models: [] }

export interface AlPersona {
  id: string
  name: string
  description: string
  avatarUrl: string
}

export interface DomPose {
  pose: string
  clothing: string
  location: string
}

export type DomAccess = 'ok' | 'signIn' | 'freeUsed'

export function domAccess(s: { ai: Pick<DomAiSettings, 'provider'>; account: Pick<DomAccount, 'signedIn' | 'freeSecondsLeft'> }, premium: boolean): DomAccess {
  if (s.ai.provider === 'own') return 'ok'
  if (!s.account.signedIn) return 'signIn'
  if (premium) return 'ok'
  return (s.account.freeSecondsLeft ?? 0) > 0 ? 'ok' : 'freeUsed'
}

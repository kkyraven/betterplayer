import type { MessageKey } from './i18n'
import { isAxisId, type AxisId } from './axes'
import type { PerVideoSettings } from './settings'

export const ACCOUNT_URL_DEFAULT = 'https://player.kinkyraven.com'
export const ACCOUNT_PORTAL_URL = 'https://account.kinkyraven.com'
export const SUBSCRIBE_URL = `${ACCOUNT_PORTAL_URL}/subscribe`
export const SUPPORTER_PRICE = '$2.70'
export const ACCOUNT_REFRESH_MS = 10 * 60_000
export const LOGIN_POLL_MS = 2000
export const LOGIN_TIMEOUT_MS = 10 * 60_000

export interface Me {
  id: string
  email: string
  name: string
  avatarUrl?: string | null
  friendCode: string
  premium: boolean
  admin: boolean
}

export const isAdmin = (me: Me | null): boolean => me?.admin === true

export interface Friend {
  id: string
  name: string
  avatarUrl?: string | null
  code: string
}

export interface FriendLists {
  friends: Friend[]
  incoming: Friend[]
  outgoing: Friend[]
}

export const NO_FRIENDS: FriendLists = { friends: [], incoming: [], outgoing: [] }

export const friendLabel = (f: Friend): string => f.name || f.code

export interface AccountStatus {
  state: 'out' | 'signingIn' | 'in' | 'error'
  me: Me | null
  friends: FriendLists
  stun: string[]
  error?: string
  syncedAt: number | null
}

export const SIGNED_OUT: AccountStatus = { state: 'out', me: null, friends: NO_FRIENDS, stun: [], syncedAt: null }

export const SYNC_VIDEO_KEYS = ['globalOffsetMs', 'axes', 'position', 'projection', 'frameGen', 'params'] as const
type SyncKey = (typeof SYNC_VIDEO_KEYS)[number]

export type SyncPayload = Pick<PerVideoSettings, SyncKey>

export interface SyncRow {
  hash: string
  updatedAt: number
  payload: SyncPayload
}

export const isContentHash = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)

export function syncPayload(video: PerVideoSettings): SyncPayload {
  const out: Partial<SyncPayload> = { globalOffsetMs: video.globalOffsetMs, axes: video.axes }
  if (video.position !== undefined) out.position = video.position
  if (video.projection !== undefined) out.projection = video.projection
  if (video.frameGen !== undefined) out.frameGen = video.frameGen
  if (video.params !== undefined) out.params = video.params
  return out as SyncPayload
}

export function mergeSynced(local: PerVideoSettings | null, remote: SyncPayload): PerVideoSettings {
  const base: PerVideoSettings = local ?? { globalOffsetMs: 0, axes: {} }
  const out: PerVideoSettings = { ...base, globalOffsetMs: remote.globalOffsetMs, axes: remote.axes }
  for (const key of ['position', 'projection', 'frameGen', 'params'] as const) {
    if (remote[key] === undefined) delete out[key]
  }
  if (remote.position !== undefined) out.position = remote.position
  if (remote.projection !== undefined) out.projection = remote.projection
  if (remote.frameGen !== undefined) out.frameGen = remote.frameGen
  if (remote.params !== undefined) out.params = remote.params
  return out
}

export const PEER_KINDS = ['control', 'watch'] as const
export type PeerKind = (typeof PEER_KINDS)[number]
export const PEER_LABELS: Record<PeerKind, MessageKey> = { control: 'together.control.title', watch: 'together.friends.watchTogether' }

export type SignalOut = ({ t: 'auth'; token: string } | { t: 'invite'; to: string; kind: PeerKind } | { t: 'accept'; to: string; kind: PeerKind } | { t: 'decline'; to: string } | { t: 'signal'; to: string; data: SignalData } | { t: 'end'; to: string }) & { sessionId?: string }

export type SignalIn = (
  | { t: 'hello'; id: string; stun: string[]; online: string[] }
  | { t: 'presence'; id: string; online: boolean }
  | { t: 'invite'; from: string; kind: PeerKind }
  | { t: 'accept'; from: string; kind: PeerKind }
  | { t: 'decline'; from: string }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'end'; from: string }
  | { t: 'friends' }
  | { t: 'error'; code: 'not_friends' | 'offline' | 'premium' | 'bad_message'; to?: string }
) & { sessionId?: string }

export type SignalData = { type: 'offer' | 'answer'; sdp: string } | { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }

export interface ControlState {
  t: 'state'
  media: boolean
  paused: boolean
  positionMs: number
  durationMs: number
  rate: number
  intensity: number | null
  stroke: number
}

export type ControlCommand =
  | { cmd: 'play' | 'pause' | 'intensityReset' }
  | { cmd: 'seek'; ms: number }
  | { cmd: 'seekBy'; s: number }
  | { cmd: 'intensity'; delta: number }
  | { cmd: 'rate'; rate: number }
  | { cmd: 'live'; axis: AxisId; value: number | null }

export type ControlCmd = { t: 'cmd' } & ControlCommand

export type WatchMsg =
  | { t: 'open'; hash: string | null; positionMs: number; paused: boolean; rate?: number }
  | { t: 'play'; positionMs: number }
  | { t: 'pause'; positionMs: number }
  | { t: 'seek'; positionMs: number }
  | { t: 'tick'; hash: string | null; positionMs: number; paused: boolean; rate?: number }
  | { t: 'missing'; hash: string }

export type PeerMsg = ControlState | ControlCmd | WatchMsg

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isHashOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && isContentHash(v))

export function parsePeerMsg(raw: unknown): PeerMsg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  switch (m.t) {
    case 'state':
      return isBool(m.media) && isBool(m.paused) && isNum(m.positionMs) && isNum(m.durationMs) && isNum(m.rate) && (m.intensity === null || isNum(m.intensity)) && isNum(m.stroke)
        ? { t: 'state', media: m.media, paused: m.paused, positionMs: m.positionMs, durationMs: m.durationMs, rate: m.rate, intensity: m.intensity, stroke: m.stroke }
        : null
    case 'cmd':
      switch (m.cmd) {
        case 'play':
        case 'pause':
        case 'intensityReset':
          return { t: 'cmd', cmd: m.cmd }
        case 'seek':
          return isNum(m.ms) ? { t: 'cmd', cmd: 'seek', ms: m.ms } : null
        case 'seekBy':
          return isNum(m.s) ? { t: 'cmd', cmd: 'seekBy', s: m.s } : null
        case 'intensity':
          return isNum(m.delta) ? { t: 'cmd', cmd: 'intensity', delta: m.delta } : null
        case 'rate':
          return isNum(m.rate) && m.rate > 0 && m.rate <= 4 ? { t: 'cmd', cmd: 'rate', rate: m.rate } : null
        case 'live':
          return typeof m.axis === 'string' && isAxisId(m.axis) && (m.value === null || isNum(m.value)) ? { t: 'cmd', cmd: 'live', axis: m.axis, value: m.value } : null
        default:
          return null
      }
    case 'open':
      return isHashOrNull(m.hash) && isNum(m.positionMs) && isBool(m.paused) ? { t: 'open', hash: m.hash, positionMs: m.positionMs, paused: m.paused, ...(isNum(m.rate) && m.rate > 0 && m.rate <= 4 ? { rate: m.rate } : {}) } : null
    case 'play':
    case 'pause':
    case 'seek':
      return isNum(m.positionMs) ? { t: m.t, positionMs: m.positionMs } : null
    case 'tick':
      return isHashOrNull(m.hash) && isNum(m.positionMs) && isBool(m.paused) ? { t: 'tick', hash: m.hash, positionMs: m.positionMs, paused: m.paused, ...(isNum(m.rate) && m.rate > 0 && m.rate <= 4 ? { rate: m.rate } : {}) } : null
    case 'missing':
      return typeof m.hash === 'string' && isContentHash(m.hash) ? { t: 'missing', hash: m.hash } : null
    default:
      return null
  }
}

export const WATCH_DRIFT_MS = 1500
export const WATCH_TICK_MS = 1000

export interface WatchLocal {
  hash: string | null
  positionMs: number
  paused: boolean
}

export type WatchFix = { do: 'open'; hash: string | null; positionMs: number; paused: boolean; rate?: number } | { do: 'play' | 'pause' | 'seek'; positionMs: number } | null

export function reconcile(local: WatchLocal, tick: Extract<WatchMsg, { t: 'tick' }>): WatchFix {
  if (tick.hash === null) return local.hash !== null && !local.paused ? { do: 'pause', positionMs: local.positionMs } : null
  if (tick.hash !== local.hash) return { do: 'open', hash: tick.hash, positionMs: tick.positionMs, paused: tick.paused }
  if (tick.paused !== local.paused) return { do: tick.paused ? 'pause' : 'play', positionMs: tick.positionMs }
  if (Math.abs(local.positionMs - tick.positionMs) > WATCH_DRIFT_MS) return { do: 'seek', positionMs: tick.positionMs }
  return null
}

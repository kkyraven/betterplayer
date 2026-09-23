import { isContentHash, parsePeerMsg, type ControlCommand, type ControlState, type Friend } from './account'

export const WATCH_GROUP_LIMIT = 16
export const FILE_CHUNK_BYTES = 16 * 1024
export const FILE_WINDOW_BYTES = 512 * 1024
export const FILE_TIMEOUT_MS = 30_000

export interface SharedVideo {
  id: string
  hash: string
  name: string
  size: number
}

export interface WatchMember {
  friend: Friend
  status: 'inviting' | 'connecting' | 'connected' | 'ended'
  missing: boolean
  note: string | null
}

export type HandoverMsg =
  | { t: 'control-offer' | 'control-end' | 'control-heartbeat'; id: string }
  | { t: 'control-answer'; id: string; accepted: boolean }
  | { t: 'control-state'; id: string; state: ControlState }
  | { t: 'control-command'; id: string; command: ControlCommand }

export type GroupMsg =
  | HandoverMsg
  | { t: 'sharing-queue'; enabled: boolean; videos: SharedVideo[] }
  | { t: 'members'; members: WatchMember[] }
  | { t: 'ready'; hash: string }
  | { t: 'sharing'; video: SharedVideo | null }
  | { t: 'file-request'; offerId: string; requestId: string }
  | { t: 'file-cancel'; requestId: string }

export const isPeerId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)

export function parseSharedVideo(raw: unknown): SharedVideo | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!isPeerId(v.id) || typeof v.hash !== 'string' || !isContentHash(v.hash) || typeof v.name !== 'string' || !v.name.length || v.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(v.name) || typeof v.size !== 'number' || !Number.isSafeInteger(v.size) || v.size <= 0) return null
  return { id: v.id, hash: v.hash, name: v.name, size: v.size }
}

export function parseGroupMsg(raw: unknown): GroupMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.t === 'sharing-queue' && typeof m.enabled === 'boolean' && Array.isArray(m.videos) && m.videos.length <= 32) {
    const videos = m.videos.map(parseSharedVideo)
    return videos.every((video): video is SharedVideo => video !== null) && new Set(videos.map(video => video.id)).size === videos.length ? { t: 'sharing-queue', enabled: m.enabled, videos } : null
  }
  if (isPeerId(m.id)) {
    if (m.t === 'control-offer' || m.t === 'control-end' || m.t === 'control-heartbeat') return { t: m.t, id: m.id }
    if (m.t === 'control-answer' && typeof m.accepted === 'boolean') return { t: m.t, id: m.id, accepted: m.accepted }
    if (m.t === 'control-state') {
      const state = parsePeerMsg(m.state)
      if (state?.t === 'state') return { t: m.t, id: m.id, state }
    }
    if (m.t === 'control-command' && m.command && typeof m.command === 'object') {
      const command = parsePeerMsg({ ...m.command, t: 'cmd' })
      if (command?.t === 'cmd' && ['intensity', 'intensityReset', 'rate', 'live'].includes(command.cmd)) return { t: m.t, id: m.id, command }
    }
  }
  if (m.t === 'sharing') {
    const video = parseSharedVideo(m.video)
    return video || m.video === null ? { t: 'sharing', video } : null
  }
  if (m.t === 'file-request' && isPeerId(m.offerId) && isPeerId(m.requestId)) return { t: 'file-request', offerId: m.offerId, requestId: m.requestId }
  if (m.t === 'file-cancel' && isPeerId(m.requestId)) return { t: 'file-cancel', requestId: m.requestId }
  if (m.t === 'ready' && typeof m.hash === 'string' && isContentHash(m.hash)) return { t: 'ready', hash: m.hash }
  if (m.t !== 'members' || !Array.isArray(m.members) || m.members.length > WATCH_GROUP_LIMIT) return null
  const members: WatchMember[] = []
  for (const rawMember of m.members) {
    if (!rawMember || typeof rawMember !== 'object') return null
    const member = rawMember as Record<string, unknown>
    if (!member.friend || typeof member.friend !== 'object') return null
    const f = member.friend as Record<string, unknown>
    if (!isPeerId(f.id) || typeof f.name !== 'string' || f.name.length > 200 || typeof f.code !== 'string' || f.code.length > 32 || typeof member.missing !== 'boolean' || !['inviting', 'connecting', 'connected', 'ended'].includes(String(member.status))) return null
    if (members.some(item => item.friend.id === f.id)) return null
    members.push({ friend: { id: f.id, name: f.name, code: f.code }, status: member.status as WatchMember['status'], missing: member.missing, note: null })
  }
  return { t: 'members', members }
}

import { hostname } from 'node:os'
import { clampToyCommand } from '@shared/headsetToys'
import type { MediaRow } from '@shared/library'
import type { ResolvedPassthrough } from '@shared/passthrough'
import type { ResolvedProjection } from '@shared/projection'
import { QUEST_PROTOCOL, type QuestBeacon, type QuestDomRequest, type QuestHello, type QuestSample, type QuestScene, type QuestSceneAudio, type QuestStream, type QuestToyCommand } from '@shared/quest'

const TEXT_LIMIT = 64

export function questBeacon(id: string, port: number, paired: boolean, name = hostname()): QuestBeacon {
  return { app: 'betterplayer', v: QUEST_PROTOCOL, id, name, port, paired }
}

export function questScene(row: MediaRow, { projection, source }: ResolvedProjection, resumeMs: number, base: string, passthrough: ResolvedPassthrough, stream?: QuestStream, audio?: QuestSceneAudio): QuestScene {
  return { id: row.id, title: row.title, url: `${base}/media/${row.id}`, durationMs: row.durationMs, resumeMs, projection, projectionSource: source, width: row.width, height: row.height, axes: row.axes, heat: row.heat, passthrough, ...(stream ? { stream } : {}), ...(audio ? { audio } : {}) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function readHello(body: unknown): QuestHello | null {
  if (!isRecord(body)) return null
  const { name, port, session } = body
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof session !== 'string' || !session.trim()) return null
  return { name: typeof name === 'string' ? name.trim().slice(0, TEXT_LIMIT) : '', port, session: session.trim().slice(0, TEXT_LIMIT) }
}

export function readPosition(body: unknown): number | null {
  if (!isRecord(body) || typeof body.ms !== 'number' || !Number.isFinite(body.ms) || body.ms < 0) return null
  return Math.round(body.ms)
}

const isMediaId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= TEXT_LIMIT

export function readSample(body: unknown): QuestSample | null {
  if (!isRecord(body)) return null
  const { timeSec, u, v } = body
  if (!isNumber(timeSec) || timeSec < 0 || !isNumber(u) || !isNumber(v)) return null
  const unit = (n: number) => Math.max(0, Math.min(1, n))
  return { timeSec, u: unit(u), v: unit(v) }
}

const REPLY_LIMIT = 2000

export function readDomRequest(body: unknown): QuestDomRequest | null {
  if (!isRecord(body)) return null
  const { kind, domId, text } = body
  if (kind === 'start') return isId(domId) ? { kind, domId } : null
  if (kind === 'send' && typeof text === 'string' && text.trim()) return { kind, text: text.trim().slice(0, REPLY_LIMIT) }
  return null
}

export function readToyCommand(body: unknown): QuestToyCommand | null {
  if (!isRecord(body)) return null
  const { kind, mediaId, value, ms, id, min, max, channel, change, on } = body
  const estim = change === 'up' ? change : isNumber(change) ? change : null
  if (kind === 'reconnect') return isId(id) ? { kind, id } : null
  if (kind === 'restimVolume' || kind === 'audioVolume') return estim !== null ? clampToyCommand({ kind, change: estim }) : null
  if (kind === 'coyote') return isId(id) && (channel === 'a' || channel === 'b') && estim !== null ? clampToyCommand({ kind, id, channel, change: estim }) : null
  if (!isMediaId(mediaId)) return null
  if (kind === 'intensity' && isNumber(value)) return clampToyCommand({ kind, mediaId, value })
  if (kind === 'offset' && isNumber(ms)) return clampToyCommand({ kind, mediaId, ms })
  if (kind === 'range' && isNumber(min) && isNumber(max)) return clampToyCommand({ kind, mediaId, min, max })
  if (kind === 'tracking' && typeof on === 'boolean') return { kind, mediaId, on }
  return null
}

const RESUME_EDGE_MS = 5000

export function resumePosition(ms: number, durationMs: number): number | undefined {
  const nearEnd = durationMs > 0 && ms > durationMs - RESUME_EDGE_MS
  return nearEnd || ms < RESUME_EDGE_MS ? undefined : ms
}

export function peerHost(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/i, '')
}

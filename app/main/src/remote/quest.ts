import { hostname } from 'node:os'
import type { MediaRow } from '@shared/library'
import type { ResolvedProjection } from '@shared/projection'
import type { QuestBeacon, QuestHello, QuestScene, QuestToyCommand } from '@shared/quest'

const TEXT_LIMIT = 64

export function questBeacon(port: number, videos: number, auth: boolean, name = hostname()): QuestBeacon {
  return { app: 'betterplayer', v: 1, name, port, videos, auth }
}

export function questScene(row: MediaRow, { projection, source }: ResolvedProjection, resumeMs: number, base: string): QuestScene {
  return { id: row.id, title: row.title, url: `${base}/media/${row.id}`, durationMs: row.durationMs, resumeMs, projection, projectionSource: source, width: row.width, height: row.height, axes: row.axes, heat: row.heat }
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

const INTENSITY_MAX = 2
const OFFSET_MAX_MS = 5000

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const isMediaId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

export function readToyCommand(body: unknown): QuestToyCommand | null {
  if (!isRecord(body)) return null
  const { kind, mediaId, value, ms, id } = body
  if (kind === 'reconnect') return typeof id === 'string' && id && id.length <= TEXT_LIMIT ? { kind, id } : null
  if (!isMediaId(mediaId)) return null
  if (kind === 'intensity' && typeof value === 'number' && Number.isFinite(value)) return { kind, mediaId, value: Math.round(clamp(value, 0, INTENSITY_MAX) * 100) / 100 }
  if (kind === 'offset' && typeof ms === 'number' && Number.isFinite(ms)) return { kind, mediaId, ms: Math.round(clamp(ms, -OFFSET_MAX_MS, OFFSET_MAX_MS)) }
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

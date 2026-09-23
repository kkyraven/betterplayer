import { createTranslator, ENGLISH, type Translate } from './i18n'

export interface PlaylistMove {
  mediaIds: number[]
  anchorId: number
  side: 'before' | 'after'
}

export function movePlaylistItems(order: readonly number[], move: PlaylistMove, t: Translate = createTranslator('en', ENGLISH)): number[] {
  const picked = new Set(move.mediaIds)
  const members = new Set(order)
  if (!members.has(move.anchorId) || [...picked].some(id => !members.has(id))) throw new Error(t('library.playlist.changed'))
  if (picked.has(move.anchorId) || picked.size === 0) return [...order]
  const remaining = order.filter(id => !picked.has(id))
  const index = remaining.indexOf(move.anchorId) + (move.side === 'after' ? 1 : 0)
  remaining.splice(index, 0, ...order.filter(id => picked.has(id)))
  return remaining
}

export function shufflePlaylist(ids: readonly number[]): number[] {
  const result = [...ids]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

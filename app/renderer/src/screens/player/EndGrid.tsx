import { X } from 'lucide-react'
import { useCallback } from 'react'
import type { MediaRow } from '@shared/library'
import { MediaCard } from '@/components/media/MediaCard'
import { IconButton } from '@/components/ui/IconButton'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import './EndGrid.css'

export function EndGrid() {
  const t = useT()
  const rows = usePlayer((s) => s.suggestions)
  const dismiss = usePlayer((s) => s.dismissSuggestions)
  const play = useCallback((row: MediaRow) => {
    const player = usePlayer.getState()
    if (!player.suggestions) return
    player.dismissSuggestions()
    void player.open(row.path)
  }, [])
  const playId = useCallback((id: number) => {
    const row = usePlayer.getState().suggestions?.find((r) => r.id === id)
    if (row) play(row)
  }, [play])
  if (!rows) return null
  return (
    <div className="end-grid">
      <div className="end-grid-inner">
        <IconButton label={t('common.close')} onClick={dismiss}>
          <X />
        </IconButton>
        <div className="end-grid-cards" role="listbox">
          {rows.map((row) => (
            <MediaCard key={row.id} row={row} flush onSelect={playId} onPlay={play} />
          ))}
        </div>
      </div>
    </div>
  )
}

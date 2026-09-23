import { Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { MediaRow } from '@shared/library'
import { TvRow } from '@/components/tv/TvRow'
import { TvSheet } from '@/components/tv/TvSheet'
import { invoke } from '@/ipc'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'

export function TvTileOptions({ row }: { row: MediaRow }) {
  const t = useT()
  const open = usePlayer((s) => s.open)
  const setTvTab = useUi((s) => s.setTvTab)
  const [favourite, setFavourite] = useState(row.favourite)
  const [rating, setRating] = useState(row.rating)
  const play = (fromStart: boolean) => {
    void open(row.path, fromStart ? 0 : undefined)
    setTvTab('nowplaying')
  }
  const fav = (on: boolean) => {
    setFavourite(on)
    void invoke('library:setFavourite', [row.id], on)
  }
  const rate = (value: number) => {
    setRating(value)
    void invoke('library:setRating', row.id, value)
  }
  return (
    <TvSheet title={row.title}>
      <TvRow kind="button" label={t('common.play')} navFirst action={<Play />} onPress={() => play(false)} />
      <TvRow kind="button" label={t('tv.tileOptions.playFromStart')} action={<RotateCcw />} onPress={() => play(true)} />
      <TvRow kind="switch" label={t('tv.tileOptions.favourite')} value={favourite} onChange={fav} />
      <TvRow kind="number" label={t('tv.tileOptions.rating')} value={rating} min={0} max={5} step={1} format={(v) => (v === 0 ? t('common.none') : t('tv.tileOptions.stars', { count: v }))} onChange={rate} />
    </TvSheet>
  )
}

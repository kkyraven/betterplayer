import { Disc3 } from 'lucide-react'
import { usePlayer } from '@/state/player'
import './AudioArt.css'

interface Props {
  compact?: boolean
}

export function AudioArt({ compact = false }: Props) {
  const audio = usePlayer((s) => s.audio)
  const title = usePlayer((s) => s.title)
  if (!audio) return null
  const { cover, artist, album, year } = audio
  const albumLine = [album, year].filter(Boolean).join(' · ')
  const style = cover ? { backgroundImage: `url(${cover})` } : undefined
  return (
    <div className="audio-art" data-compact={compact || undefined}>
      <div className={cover ? 'bg' : 'bg none'} style={style} />
      <div className="tint" />
      <div className="body">
        <div className={cover ? 'cover' : 'cover none'} style={style}>
          {!cover && <Disc3 />}
        </div>
        {!compact && (
          <div className="text">
            <h1>{audio.title ?? title}</h1>
            {artist && <p className="artist">{artist}</p>}
            {albumLine && <p className="album">{albumLine}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

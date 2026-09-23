import { useState, type CSSProperties } from 'react'
import { cueAt } from '@shared/subtitles'
import * as live from '@/state/live'
import { useSettings } from '@/state/settings'
import { useSubtitles } from '@/state/subtitles'
import './Subtitles.css'

export function Subtitles() {
  const cues = useSubtitles((s) => s.cues)
  const settings = useSettings((s) => s.settings?.subtitles)
  const [index, setIndex] = useState(-1)
  live.useLive(
    (l) => {
      const at = cueAt(cues, l.timeMs)
      setIndex((prev) => (prev === at ? prev : at))
    },
    [cues],
  )
  const cue = cues[index]
  if (!settings?.enabled || !cue) return null
  return (
    <div className="captions" data-size={settings.size} data-colour={settings.colour} data-style={settings.style} style={{ '--captions-bottom': `${settings.position * 100}%` } as CSSProperties} aria-live="off">
      {cue.text.split('\n').map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </div>
  )
}

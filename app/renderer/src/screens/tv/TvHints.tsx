import { useSyncExternalStore } from 'react'
import { padKind, padStore, type PadKind } from '@/input/gamepad'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

export type HintContext = 'rows' | 'grid' | 'nowplaying' | 'overlay' | 'settings' | 'session'

type Glyphs = { select: string; back: string; options: string; power: string; pause: string }

const GLYPHS: Record<PadKind, Glyphs> = {
  none: { select: '⏎', back: '⌫', options: 'O', power: 'T', pause: 'Space' },
  xbox: { select: 'A', back: 'B', options: 'X', power: 'View', pause: 'Y' },
  playstation: { select: '✕', back: '○', options: '□', power: 'Create', pause: '△' },
  generic: { select: '1', back: '2', options: '3', power: 'View', pause: '4' },
}

export function TvHints({ context }: { context: HintContext }) {
  const t = useT()
  const show = useSettings((s) => s.settings?.tv.hints ?? true)
  const id = useSyncExternalStore(padStore.subscribe, padStore.get)
  if (!show) return null
  const kind = padKind(id)
  const g = GLYPHS[kind]
  const hints: Array<[string, string]> = []
  if (context === 'nowplaying') hints.push([g.pause, t('common.pause')], [g.options, t('tv.quickSettings.title')])
  else if (context === 'rows' || context === 'grid') hints.push([g.select, t('common.play')], [g.options, t('common.options')])
  else if (context === 'settings') hints.push(['◀ ▶', t('tv.hints.change')])
  else if (context === 'session') hints.push([g.select, t('common.select')])
  hints.push([g.back, t('common.back')])
  if (context !== 'overlay') hints.push([g.power, kind === 'none' ? t('tv.hints.desktop') : t('tv.powerMenu.title')])
  return (
    <div className="hints">
      {hints.map(([key, label]) => (
        <span key={label}>
          <span className="kbd">{key}</span>
          {label}
        </span>
      ))}
    </div>
  )
}

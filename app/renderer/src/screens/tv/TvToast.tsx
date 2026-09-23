import { useEffect, useState } from 'react'
import type { ActionId } from '@/input/actions'
import { cx } from '@/lib/cx'
import { isAxisId } from '@shared/axes'
import { t } from '@/state/i18n'
import * as live from '@/state/live'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'

const SHOW_MS = 1200

export function scriptedAmplitude(): number {
  const first = live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_DERIVED).find(isAxisId)
  if (!first) return 1
  return usePlayer.getState().video.axes[first]?.amplitude ?? useSettings.getState().settings?.axesDefault[first].amplitude ?? 1
}

export function toastFor(id: ActionId): string | null {
  const p = usePlayer.getState()
  if (id.startsWith('Media.Volume.') || id === 'Media.Mute.Toggle') return p.muted ? t('tv.toast.muted') : t('tv.toast.volume', { value: Math.round(p.volume * 100) })
  if (id.startsWith('Media.Intensity.')) return t('tv.toast.intensity', { value: Math.round(scriptedAmplitude() * 100) })
  if (id.startsWith('Media.Offset.')) return t('tv.toast.offset', { value: p.video.globalOffsetMs })
  return null
}

export function TvToast() {
  const toast = useUi((s) => s.tvToast)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!toast) return
    setOn(true)
    const timer = window.setTimeout(() => setOn(false), SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [toast])
  return (
    <div className={cx('tv-toast', on && 'on')} role="status" aria-live="polite">
      {toast?.text}
    </div>
  )
}

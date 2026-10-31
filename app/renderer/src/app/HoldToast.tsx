import { useEffect, useState } from 'react'
import { cx } from '@/lib/cx'
import { bindingLabel, bindingsFor } from '@/input/actions'
import { useDevices } from '@/state/devices'
import { useGame } from '@/state/game'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import '@/components/ui/Toast.css'

const SHOW_MS = 4000

export function HoldToast() {
  const t = useT()
  const held = useDevices((s) => s.held)
  const path = usePlayer((s) => s.path)
  const game = useGame((s) => s.running)
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(held)
    if (!held) return
    const timer = window.setTimeout(() => setOn(false), SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [held, path])
  const key = !game && bindingsFor('Devices.Hold.Toggle').find((k) => !k.startsWith('pad:') && !k.startsWith('device:'))
  return (
    <div className="hold-toast-region" role="status" aria-live="polite">
      <div className={cx('toast hold-toast', !on && 'off', !held && 'gone')}>
        {held && <span>{key ? t('app.holdToast.pausedKey', { key: bindingLabel(key) }) : t('app.holdToast.paused')}</span>}
      </div>
    </div>
  )
}

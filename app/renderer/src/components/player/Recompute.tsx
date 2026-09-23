import { useT } from '@/state/i18n'
import { useRecompute } from '@/state/recompute'
import './Recompute.css'

export function Recompute() {
  const t = useT()
  const busy = useRecompute((s) => s.busy)
  const devices = useRecompute((s) => s.devices)
  const percent = useRecompute((s) => s.percent)
  const cancel = useRecompute((s) => s.cancel)
  if (!busy) return null
  return (
    <div className="recompute" role="status">
      <div className="rbox">
        <p>
          {t('player.recompute.progress', { devices })}
          {percent !== null && ` ${percent}%`}
        </p>
        <span className="rbar">
          <i style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} />
        </span>
        <button type="button" onClick={cancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

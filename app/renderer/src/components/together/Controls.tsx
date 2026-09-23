import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlState } from '@shared/account'
import { Stepper } from '@/components/ui/Stepper'
import { useT } from '@/state/i18n'
import { RATES } from '@/state/player'
import { useTogether } from '@/state/together'

const LIVE_EVERY_MS = 40
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

export function Controls({ remote }: { remote: ControlState | null }) {
  const t = useT()
  const command = useTogether((s) => s.command)
  const lastLive = useRef(0)
  const holding = useRef(false)
  const [held, setHeld] = useState(false)
  const hold = () => {
    holding.current = true
    setHeld(true)
  }
  const release = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    setHeld(false)
    lastLive.current = 0
    command({ cmd: 'live', axis: 'L0', value: null })
  }, [command])
  useEffect(() => {
    window.addEventListener('blur', release)
    const hidden = () => { if (document.hidden) release() }
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hidden); release() }
  }, [release])
  if (!remote) return <div className="st">{t('together.session.connecting')}</div>
  const found = RATES.findIndex((r) => r >= remote.rate - 0.001)
  const rateIndex = found < 0 ? RATES.length - 1 : found
  const intensity = remote.intensity
  const live = (value: number) => {
    hold()
    const now = Date.now()
    if (now - lastLive.current < LIVE_EVERY_MS) return
    lastLive.current = now
    command({ cmd: 'live', axis: 'L0', value })
  }
  return (
    <>
      {intensity !== null && (
        <div className="row">
          <span>{t('together.controls.intensity')}</span>
          <Stepper value={Math.round(intensity * 100)} max={200} step={5} label={t('together.controls.intensity')} onChange={(v) => command({ cmd: 'intensity', delta: (v - Math.round(intensity * 100)) / 100 })} />
        </div>
      )}
      {remote.media && <div className="row">
        <span>{t('together.controls.speed')}</span>
        <Stepper value={rateIndex} max={RATES.length - 1} step={1} format={(i) => `${RATES[i] ?? 1}×`} label={t('together.controls.speed')} onChange={(i) => command({ cmd: 'rate', rate: RATES[i] ?? 1 })} />
      </div>}
      <div className="live">
        <span className="k">
          {t('together.controls.stroke')} <b>{t(held ? 'together.controls.strokeYou' : 'together.controls.strokeScript')}</b>
        </span>
        <div className="track">
          <span className="mark" style={{ left: `${remote.stroke * 100}%` }} />
          <input
            className="vol"
            type="range"
            min={0}
            max={100}
            defaultValue={50}
            aria-label={t('together.controls.stroke')}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              hold()
            }}
            onKeyDown={(e) => {
              if (SLIDER_KEYS.has(e.key)) hold()
            }}
            onInput={(e) => live(Number(e.currentTarget.value) / 100)}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onKeyUp={(e) => {
              if (SLIDER_KEYS.has(e.key)) release()
            }}
            onBlur={release}
          />
        </div>
      </div>
    </>
  )
}

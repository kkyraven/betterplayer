import * as Popover from '@radix-ui/react-popover'
import { useRef, useState } from 'react'
import { Slider } from '@/components/ui/Slider'
import { cx } from '@/lib/cx'
import { RATES, RATE_GRID_MIN, RATE_MAX, RATE_MIN, RATE_STEP, stepRate } from '@/lib/rate'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useMenuEscape } from './VariantMenu'

const ARROWS: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }

export function SpeedMenu({ rate, overlay }: { rate: number; overlay: HTMLDivElement | null }) {
  const t = useT()
  const chooseRate = usePlayer((s) => s.chooseRate)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useMenuEscape(open, setOpen, trigger)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button ref={trigger} type="button" className="rate" aria-label={t('player.controls.speed')}>
          {rate}×
        </button>
      </Popover.Trigger>
      {overlay && (
        <Popover.Portal container={overlay}>
          <Popover.Content
            className="varmenu speedmenu"
            side="top"
            align="end"
            sideOffset={10}
            onKeyDownCapture={(e) => {
              const dir = ARROWS[e.key]
              if (!dir) return
              e.preventDefault()
              e.stopPropagation()
              chooseRate(stepRate(rate, dir))
            }}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
            }}
          >
            <div className="head">
              <span>{t('player.controls.speed')}</span>
              <b>{rate}×</b>
            </div>
            <Slider value={[rate]} min={RATE_GRID_MIN} max={RATE_MAX} step={RATE_STEP} label={t('player.controls.speed')} onValueChange={([v]) => chooseRate(Math.max(RATE_MIN, v ?? 1))} />
            <div className="presets">
              {RATES.map((r) => (
                <button key={r} type="button" className={cx(Math.abs(r - rate) < 0.001 && 'on')} aria-label={`${r}×`} onClick={() => chooseRate(r)}>
                  {r}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  )
}

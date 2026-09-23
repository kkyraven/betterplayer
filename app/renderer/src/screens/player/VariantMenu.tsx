import * as Popover from '@radix-ui/react-popover'
import { Check, Layers } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AXIS_NAME, isAxisId, type AxisId } from '@shared/axes'
import type { ScriptInfo } from 'bp-engine'
import { cx } from '@/lib/cx'
import { fmtSpeed } from '@/lib/format'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'

export function variantGroups(scripts: ScriptInfo[]): [AxisId, ScriptInfo[]][] {
  const byAxis = new Map<AxisId, ScriptInfo[]>()
  for (const s of scripts) {
    if (!isAxisId(s.axis)) continue
    const list = byAxis.get(s.axis) ?? []
    list.push(s)
    byAxis.set(s.axis, list)
  }
  return [...byAxis.entries()].filter(([, list]) => list.length > 1)
}

export function VariantMenu({ groups, overlay }: { groups: [AxisId, ScriptInfo[]][]; overlay: HTMLDivElement | null }) {
  const t = useT()
  const selectVariant = usePlayer((s) => s.selectVariant)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      if (trigger.current?.closest('[data-chrome]')?.getAttribute('data-chrome') === 'shown') e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const single = groups.length === 1 ? groups[0] : undefined
  const current = single?.[1].find((s) => s.selected) ?? single?.[1][0]
  const label = current ? (current.variant ?? t('common.default')) : t('player.variant.scripts')
  const varied = groups.some(([, list]) => list.some((s) => s.selected && s.variant != null))

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button ref={trigger} type="button" className={cx('varbtn', varied && 'on')} aria-label={single ? t('player.variant.script', { name: label }) : t('player.variant.variants')}>
          <Layers />
          {label}
        </button>
      </Popover.Trigger>
      {overlay && (
        <Popover.Portal container={overlay}>
          <Popover.Content
            className="varmenu"
            side="top"
            align="end"
            sideOffset={10}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter' || e.key.startsWith('Arrow')) e.stopPropagation()
            }}
          >
            {groups.map(([axis, list]) => (
              <div key={axis}>
                {groups.length > 1 && <div className="glabel">{t(AXIS_NAME[axis])}</div>}
                {list.map((s) => (
                  <button
                    key={s.variant ?? ''}
                    type="button"
                    className="item"
                    onClick={() => {
                      selectVariant(axis, s.variant ?? null)
                      setOpen(false)
                    }}
                  >
                    <span>{s.variant ?? t('common.default')}</span>
                    <span className="spd">{fmtSpeed(s.averageSpeed)}</span>
                    <span className="tick">{s.selected && <Check />}</span>
                  </button>
                ))}
              </div>
            ))}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  )
}

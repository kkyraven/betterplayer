import { AXIS_LABEL, AXIS_NAME, type AxisId } from '@shared/axes'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import './AxisToggles.css'

export function AxisToggles({ axes, on, variant, onChange }: { axes: readonly AxisId[]; on: readonly AxisId[]; variant: 'on' | 'off'; onChange: (next: AxisId[]) => void }) {
  const t = useT()
  return (
    <div className="axtoggles">
      {axes.map((id) => {
        const active = on.includes(id)
        return (
          <button
            key={id}
            type="button"
            className={cx('axtoggle', active && variant)}
            title={t(AXIS_NAME[id])}
            aria-label={t(AXIS_NAME[id])}
            aria-pressed={active}
            onClick={() => onChange(active ? on.filter((a) => a !== id) : [...on, id])}
          >
            {AXIS_LABEL[id]}
            {id === 'EA' || id === 'EB' || id === 'EV' ? ` ${t(AXIS_NAME[id])}` : ''}
          </button>
        )
      })}
    </div>
  )
}

import { AXIS_LABEL, AXIS_NAME, isAxisId } from '@shared/axes'
import { useT } from '@/state/i18n'
import './AxisChips.css'

interface Props {
  axes: readonly string[]
}

export function AxisChips({ axes }: Props) {
  const t = useT()
  if (axes.length === 0) return <span className="axis axis-none">{t('media.noScript')}</span>
  return (
    <span className="axes">
      {axes.map((a) => (
        <span key={a} className="axis" title={isAxisId(a) ? t(AXIS_NAME[a]) : a}>
          {isAxisId(a) ? AXIS_LABEL[a] : a}
        </span>
      ))}
    </span>
  )
}

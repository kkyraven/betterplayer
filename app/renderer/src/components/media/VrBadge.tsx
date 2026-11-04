import type { ProjectionKind } from '@shared/projection'
import { VrGogglesIcon } from '@/components/ui/VrGogglesIcon'
import { useT } from '@/state/i18n'
import './VrBadge.css'

export function VrBadge({ projection }: { projection: ProjectionKind }) {
  const t = useT()
  if (projection === 'flat') return null
  const degrees = projection === 'equirect360' ? '360' : '180'
  const label = t('media.vr', { degrees })
  return (
    <span className="vr-badge" title={label} aria-label={label}>
      <VrGogglesIcon aria-hidden />
      {degrees}°
    </span>
  )
}

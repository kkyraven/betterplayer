import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'
import './HeroTip.css'

export function HeroTip() {
  const t = useT()
  const shown = useTracking((s) => s.heroTip && s.source === 'player' && Object.values(s.axes).some((a) => a.source === 'hero' || (s.heroMusic.enabled && a.source === 'ai-music')))
  const dismiss = useTracking((s) => s.dismissHeroTip)
  if (!shown) return null
  return (
    <div className="hero-tip" role="note">
      <p>
        {t('tracking.heroTip.body')}
        <span className="sig">&lt;3 -- kinkyraven</span>
      </p>
      <IconButton label={t('common.close')} size="sm" onClick={dismiss}>
        <X />
      </IconButton>
    </div>
  )
}

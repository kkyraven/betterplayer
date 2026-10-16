import { ExternalLink, Lock } from 'lucide-react'
import { SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { electron } from '@/node'
import { useT } from '@/state/i18n'
import './SupporterOffer.css'

export function SupporterOffer({ message }: { message?: string }) {
  const t = useT()
  return (
    <div className="supporter-offer">
      <Lock />
      <span>
        {message ?? t('game.supporterOnly')} <span className="supporter-offer-price">{t('game.priceFrom', { price: SUPPORTER_PRICE })}</span>
      </span>
      <Button variant="primary" onClick={() => void electron.shell.openExternal(SUBSCRIBE_URL)}>
        {t('firstStart.supporter.become')}
        <ExternalLink />
      </Button>
    </div>
  )
}

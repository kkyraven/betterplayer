import { ExternalLink } from 'lucide-react'
import { Fragment, useState } from 'react'
import { ACCOUNT_PORTAL_URL, SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import { checkSupporter, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'

const FEATURES: ReadonlyArray<readonly [MessageKey, MessageKey]> = [
  ['settings.support.feature.hmv', 'settings.support.feature.hmvSub'],
  ['settings.support.feature.adBlock', 'settings.support.feature.adBlockSub'],
  ['settings.support.feature.together', 'settings.support.feature.togetherSub'],
  ['settings.support.feature.denial', 'settings.support.feature.denialSub'],
  ['settings.support.feature.dlss', 'settings.support.feature.dlssSub'],
  ['settings.support.feature.theme', 'settings.support.feature.themeSub'],
]

export function SupportSettings() {
  const t = useT()
  const status = useAccount((s) => s.status)
  const premium = status.me?.premium === true
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const refresh = async () => {
    setBusy(true)
    setMessage(await checkSupporter())
    setBusy(false)
  }
  const open = (url: string) => {
    setMessage(null)
    void electron.shell.openExternal(url).catch((error: unknown) => setMessage(ipcMessage(error)))
  }
  return (
    <div className="set-support">
      <dl className="features">
        {FEATURES.map(([name, what]) => (
          <Fragment key={name}>
            <dt>{t(name)}</dt>
            <dd>{t(what)}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="ask" data-setting="become-a-supporter" tabIndex={-1}>
        {premium ? (
          <span className="price">{t('settings.support.thankYou')}</span>
        ) : (
          <span className="price">
            {t('settings.support.priceFrom')} <strong>{SUPPORTER_PRICE}</strong> {t('settings.support.priceAfter')}
          </span>
        )}
        <span className="spacer" />
        {premium ? (
          <Button onClick={() => open(ACCOUNT_PORTAL_URL)}>
            {t('settings.support.manage')}
            <ExternalLink />
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
              {busy ? t('settings.support.checking') : status.me ? t('settings.support.refreshStatus') : t('settings.profile.signIn')}
            </Button>
            <Button variant="primary" onClick={() => open(SUBSCRIBE_URL)}>
              {t('settings.support.become')}
              <ExternalLink />
            </Button>
          </>
        )}
      </div>
      {message && (
        <p className="sub error" role="status">
          {message}
        </p>
      )}

    </div>
  )
}

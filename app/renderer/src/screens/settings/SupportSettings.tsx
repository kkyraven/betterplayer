import { ExternalLink } from 'lucide-react'
import { Fragment, useState } from 'react'
import { ACCOUNT_PORTAL_URL, SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import { AGENTIC_LOVER_URL } from '@shared/dom'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import { checkAgenticLover, checkSupporter, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'

const FEATURES: ReadonlyArray<readonly [MessageKey, MessageKey]> = [
  ['settings.support.feature.aiDom', 'settings.support.feature.aiDomSub'],
  ['settings.support.feature.hmv', 'settings.support.feature.hmvSub'],
  ['settings.support.feature.adBlock', 'settings.support.feature.adBlockSub'],
  ['settings.support.feature.together', 'settings.support.feature.togetherSub'],
  ['settings.support.feature.denial', 'settings.support.feature.denialSub'],
  ['settings.support.feature.dlss', 'settings.support.feature.dlssSub'],
]

export function SupportSettings() {
  const t = useT()
  const status = useAccount((s) => s.status)
  const premium = status.me?.premium === true
  const [busy, setBusy] = useState<'portal' | 'agenticLover' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const refresh = async (from: 'portal' | 'agenticLover') => {
    setBusy(from)
    setMessage(await (from === 'portal' ? checkSupporter() : checkAgenticLover()))
    setBusy(null)
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
          <Button onClick={() => open(status.me?.agenticLover ? AGENTIC_LOVER_URL : ACCOUNT_PORTAL_URL)}>
            {t('settings.support.manage')}
            <ExternalLink />
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={() => void refresh('portal')}>
              {busy === 'portal' ? t('settings.support.checking') : status.me ? t('settings.support.refreshStatus') : t('settings.profile.signIn')}
            </Button>
            {status.me && (
              <Button variant="ghost" disabled={busy !== null} onClick={() => void refresh('agenticLover')}>
                {busy === 'agenticLover' ? t('settings.support.checking') : t('settings.support.refreshFromAl')}
              </Button>
            )}
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

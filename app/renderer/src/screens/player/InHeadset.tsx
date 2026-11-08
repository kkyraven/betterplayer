import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'
import { ITCH_URL, SUBSCRIBE_URL } from '@shared/account'
import type { MessageKey } from '@shared/i18n'
import type { VrError } from '@shared/vr'
import { Button } from '@/components/ui/Button'
import { Toast } from '@/components/ui/Toast'
import { VrGogglesIcon } from '@/components/ui/VrGogglesIcon'
import { focusFirst } from '@/input/spatialNav'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import { cancelItchLink, checkPurchase, isLinkingItch, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useVr } from '@/state/vr'
import './InHeadset.css'

const ERROR_TEXT: Record<VrError, MessageKey> = {
  'not-installed': 'vr.error.notInstalled',
  'not-running': 'vr.error.notRunning',
  'no-headset': 'vr.error.noHeadset',
  'other-gpu': 'vr.error.otherGpu',
  'old-steamvr': 'vr.error.oldSteamvr',
  timeout: 'vr.error.timeout',
  busy: 'vr.error.busy',
  quit: 'vr.error.quit',
  'no-interop': 'vr.error.failed',
  compositor: 'vr.error.failed',
  failed: 'vr.error.failed',
}

export function InHeadset() {
  return (
    <>
      <HeadsetCard />
      <VrErrorToast />
    </>
  )
}

export function HeadsetCard() {
  const t = useT()
  const active = useVr((s) => s.active)
  const hmdName = useVr((s) => s.hmdName)
  const stop = useVr((s) => s.stop)
  if (!active) return null
  return (
    <div className="in-headset">
      <VrGogglesIcon className="ih-icon" />
      <h2>{t('vr.inHeadset')}</h2>
      {hmdName && <span className="muted">{hmdName}</span>}
      <Button onClick={() => stop()}>{t('vr.backToDesktop')}</Button>
    </div>
  )
}

export function VrErrorToast() {
  const t = useT()
  const error = useVr((s) => s.error)
  const clearError = useVr((s) => s.clearError)
  if (!error) return null
  return (
    <div className="ih-toast">
      <Toast key={error} message={t(ERROR_TEXT[error])} onHide={clearError} />
    </div>
  )
}

export async function openPage(url: string): Promise<string | null> {
  try {
    await electron.shell.openExternal(url)
    return null
  } catch (error) {
    return ipcMessage(error)
  }
}

export function VrOffer() {
  const offer = useVr((s) => s.offer)
  const hide = useVr((s) => s.hideOffer)
  const ref = useRef<HTMLDivElement>(null)
  const [checking, setChecking] = useState(false)
  const linking = useAccount(isLinkingItch)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!offer) return
    setMessage(null)
    const before = document.activeElement
    if (ref.current) focusFirst(ref.current)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      useVr.getState().hideOffer()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [offer])
  if (!offer) return null
  const open = async (url: string) => setMessage(await openPage(url))
  const purchased = async () => {
    setChecking(true)
    const result = await checkPurchase()
    setChecking(false)
    setMessage(result)
    if (result !== null) return
    hide()
    const vr = useVr.getState()
    if (!vr.active && !vr.starting) void vr.start()
  }
  return (
    <div className="in-headset vr-offer" onClick={(e) => e.target === e.currentTarget && hide()}>
      <VrOfferCard ref={ref} trap open={(url) => void open(url)} notNow={hide} purchased={() => void purchased()} checking={checking} cancel={linking ? cancelItchLink : undefined} message={message} />
    </div>
  )
}

export function VrOfferCard({ ref, trap = false, open, notNow, purchased, checking, cancel, message }: { ref?: Ref<HTMLDivElement>; trap?: boolean; open: (url: string) => void; notNow: () => void; purchased: () => void; checking: boolean; cancel?: () => void; message: string | null }) {
  const t = useT()
  return (
    <div ref={ref} className="vr-offer-card" role="dialog" aria-labelledby="vr-offer-title" data-nav-trap={trap || undefined}>
      <VrGogglesIcon className="ih-icon" />
      <h2 id="vr-offer-title">{t('vr.offer.title')}</h2>
      <span className="muted">{t('vr.offer.body')}</span>
      <div className="vr-offer-actions">
        <Button variant="primary" data-key="offer:subscribe" onClick={() => open(SUBSCRIBE_URL)}>
          {t('firstStart.supporter.become')}
          <ExternalLink />
        </Button>
        <Button data-key="offer:itch" onClick={() => open(ITCH_URL)}>
          {t('vr.offer.itch')}
          <ExternalLink />
        </Button>
        <Button variant="ghost" data-key="offer:not-now" onClick={notNow}>
          {t('vr.offer.notNow')}
        </Button>
      </div>
      <span className="vr-offer-fine">
        {t('vr.offer.email')}{' '}
        <button type="button" className="vr-offer-link" data-key="offer:purchased" disabled={checking && !cancel} onClick={cancel ?? purchased}>
          {cancel ? t('common.cancel') : checking ? t('settings.support.checking') : t('vr.offer.purchased')}
        </button>
      </span>
      {message && <span className="vr-offer-fine error" role="status">{message}</span>}
    </div>
  )
}

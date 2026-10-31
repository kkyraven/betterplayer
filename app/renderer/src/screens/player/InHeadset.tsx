import { RectangleGoggles } from 'lucide-react'
import type { MessageKey } from '@shared/i18n'
import type { VrError } from '@shared/vr'
import { Button } from '@/components/ui/Button'
import { Toast } from '@/components/ui/Toast'
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
      <RectangleGoggles className="ih-icon" />
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

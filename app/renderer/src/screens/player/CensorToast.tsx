import { useEffect, useState } from 'react'
import { detectorId, sizeOf } from '@shared/censor'
import { Button } from '@/components/ui/Button'
import { Toast } from '@/components/ui/Toast'
import { isFree, useAccount } from '@/state/account'
import { useCensor } from '@/state/censor'
import { useT } from '@/state/i18n'
import { useModels } from '@/state/models'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { openSettings } from '@/state/settingsNavigation'

let shown = false

export function CensorToast() {
  const t = useT()
  const size = sizeOf(useSettings((s) => s.settings?.tracking.models.detector))
  const download = useModels((s) => (size ? s.downloads[detectorId(size)] : undefined))
  const reason = useCensor((s) => {
    if (!s.synced || !s.censor.enabled) return null
    if (s.running?.status === 'error') return t('settings.models.failed', { error: s.running.error ?? '' })
    if (s.detector === 'installed' || s.engineSetup) return null
    return download?.status === 'error' ? t('settings.models.failed', { error: download.error }) : t('settings.models.notDownloaded')
  })
  const free = useAccount(isFree)
  const loaded = usePlayer((s) => s.path !== null && s.snapshot.loaded)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (shown || !reason || free || !loaded) return
    shown = true
    setMessage(`${t('player.toast.hideNotRunning')} · ${reason}`)
  }, [reason, free, loaded, t])

  if (!message) return null
  return (
    <div className="track-toast">
      <Toast
        message={message}
        action={
          <Button
            variant="ghost"
            onClick={() => {
              setMessage(null)
              openSettings('censor')
            }}
          >
            {t('screen.settings')}
          </Button>
        }
        onHide={() => setMessage(null)}
      />
    </div>
  )
}

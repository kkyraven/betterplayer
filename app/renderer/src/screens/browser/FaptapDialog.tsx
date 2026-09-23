import { INTIFACE_PORT_DEFAULT } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { intifaceStatusLine, useIntifaceEnabled, useIntifaceStatus } from '@/state/intiface'
import { useSettings } from '@/state/settings'
import '@/components/ui/Prompt.css'

interface Props {
  open: boolean
  onClose: () => void
}

export function FaptapDialog({ open, onClose }: Props) {
  const t = useT()
  const enabled = useIntifaceEnabled()
  const port = useSettings((s) => s.settings?.intiface.port ?? INTIFACE_PORT_DEFAULT)
  const status = useIntifaceStatus()
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t('browser.faptap.title')} width={420}>
      <div className="prompt faptap">
        <h2>{t('browser.faptap.title')}</h2>
        <p>{t('browser.faptap.body')}</p>
        <ol>
          <li>
            {t('settings.intiface.actAs')}
            <span className={cx('faint', enabled && status.error && 'err')}>{intifaceStatusLine(enabled, port, status)}</span>
          </li>
          <li>
            {t('browser.faptap.step2')}
            <code>ws://localhost:{port}</code>
          </li>
        </ol>
        <div className="actions">
          <Button variant="primary" onClick={onClose}>{t('common.done')}</Button>
        </div>
      </div>
    </Modal>
  )
}

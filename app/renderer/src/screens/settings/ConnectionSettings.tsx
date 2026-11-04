import { INTIFACE_PORT_DEFAULT } from '@shared/settings'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { intifaceStatusLine, useIntifaceEnabled, useIntifaceStatus } from '@/state/intiface'
import { useSettings } from '@/state/settings'

export function IntifacePanel() {
  const t = useT()
  const enabled = useSettings((s) => s.settings?.intiface.alwaysOn ?? false)
  const active = useIntifaceEnabled()
  const port = useSettings((s) => s.settings?.intiface.port ?? INTIFACE_PORT_DEFAULT)
  const update = useSettings((s) => s.update)
  const status = useIntifaceStatus()
  const line = intifaceStatusLine(active, port, status)
  return (
    <div className="dev-intiface">
      <span className="eyebrow">
        {t('settings.intiface.actAs')}
        <Switch checked={enabled} onCheckedChange={(on) => void update((s) => ({ ...s, intiface: { ...s.intiface, alwaysOn: on } }))} label={t('settings.intiface.actAs')} />
      </span>
      <span className={cx('faint', active && status.error && 'err')}>{line}</span>
    </div>
  )
}

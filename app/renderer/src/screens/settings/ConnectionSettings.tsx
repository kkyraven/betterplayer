import { INTIFACE_PORT_DEFAULT } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { fileTitle } from '@/lib/format'
import { FOLLOW_KINDS, FOLLOW_LABELS, useFollow } from '@/state/follow'
import { useT } from '@/state/i18n'
import { intifaceStatusLine, useIntifaceEnabled, useIntifaceStatus } from '@/state/intiface'
import { useSettings } from '@/state/settings'
const KIND_OPTIONS = FOLLOW_KINDS.map((k) => ({ value: k, label: FOLLOW_LABELS[k] }))

export function FollowPanel() {
  const t = useT()
  const kind = useFollow((s) => s.kind)
  const host = useFollow((s) => s.host)
  const state = useFollow((s) => s.state)
  const matched = useFollow((s) => s.matched)
  const setKind = useFollow((s) => s.setKind)
  const setHost = useFollow((s) => s.setHost)
  const start = useFollow((s) => s.start)
  const stop = useFollow((s) => s.stop)
  const status = !state
    ? null
    : state.status === 'connected'
      ? state.path
        ? matched
          ? state.playing
            ? t('settings.headsets.playing')
            : t('settings.headsets.paused')
          : t('settings.headsets.noScript')
        : t('settings.headsets.nothingOpen')
      : state.status === 'error'
        ? (state.error ?? t('common.error'))
        : t('common.connecting')
  return (
    <div className="dev-follow">
      <span className="eyebrow">{t('settings.headsets.headset')}</span>
      {state ? (
        <>
          <div className="st">
            <span className={`dot ${state.status === 'connected' ? (state.path && matched ? '' : 'warn') : state.status === 'error' ? 'danger' : 'warn'}`} />
            <span>{FOLLOW_LABELS[kind]}</span>
            <span className="p" title={state.path}>
              {state.path ? fileTitle(state.path) : status}
            </span>
          </div>
          {state.path && <span className="faint">{status}</span>}
          <Button onClick={stop}>{t('settings.headsets.stopFollowing')}</Button>
        </>
      ) : (
        <>
          <span className="sub" data-setting="headset-unavailable" tabIndex={-1}>
            {t('settings.headsets.notFollowing')}
          </span>
          <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} label={t('settings.headsets.player')} />
          <div className="row">
            <input className="input mono" value={host} aria-label={t('settings.headsets.address')} placeholder={t('settings.headsets.addressPlaceholder')} onChange={(e) => setHost(e.target.value)} />
            <Button onClick={start}>{t('settings.headsets.follow')}</Button>
          </div>
        </>
      )}
    </div>
  )
}

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

import { useEffect, useState } from 'react'
import { parseReleaseNotes } from '@shared/update'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { ipcMessage } from '@/lib/errors'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'
import { updateText, useUpdate } from '@/state/update'

const RELEASES = parseReleaseNotes(__RELEASE_NOTES__).slice(0, 4)

export function TelemetrySettings() {
  const t = useT()
  const usageStats = useSettings((s) => s.settings?.account.usageStats ?? true)
  const update = useSettings((s) => s.update)
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveUsageStats = async (usageStats: boolean) => {
    setSaveError(null)
    try {
      await update((s) => ({ ...s, account: { ...s.account, usageStats } }))
    } catch (error) {
      setSaveError(ipcMessage(error))
    }
  }
  return (
    <>
      <div className="panel">
        <div className="prow">
          <div>
            <div className="lbl">{t('settings.privacy.sendUsageStats')}</div>
            <div className="sub">{t('settings.privacy.sendUsageStatsSub')}</div>
          </div>
          <span className="spacer" />
          <Switch checked={usageStats} onCheckedChange={(on) => void saveUsageStats(on)} label={t('settings.privacy.sendUsageStats')} />
        </div>
      </div>
      {saveError && <p className="sub error" role="alert">{saveError}</p>}
    </>
  )
}

export function AboutSettings() {
  const t = useT()
  const version = useUpdate((s) => s.version)
  const update = useUpdate((s) => s.state)
  const start = useUpdate((s) => s.start)
  const check = useUpdate((s) => s.check)
  const install = useUpdate((s) => s.install)
  useEffect(start, [start])
  const busy = update.status === 'checking' || update.status === 'downloading'
  return (
    <div className="set-about">
      <div className="panel">
        <div className="prow" data-setting="version" tabIndex={-1}>
          <span>
            <div className="lbl">{t('settings.about.version', { version })}</div>
            {updateText(update) && <div className="sub">{updateText(update)}</div>}
          </span>
          <span className="spacer" />
          {update.status === 'ready' ? (
            <Button variant="primary" onClick={() => void install()}>
              {t('settings.about.restartToUpdate')}
            </Button>
          ) : (
            <Button disabled={busy || update.status === 'off'} onClick={() => void check()}>
              {t('settings.about.checkForUpdates')}
            </Button>
          )}
        </div>
      </div>
      {RELEASES.length > 0 && (
        <section className="releases" data-setting="recent-releases" tabIndex={-1}>
          <h2>{t('settings.support.recentReleases')}</h2>
          {RELEASES.map((release) => (
            <div className="rel" key={release.version}>
              <b>{release.version}</b>
              <ul>
                {release.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

export function AdvancedSettings() {
  const t = useT()
  const setFirstStart = useUi((s) => s.setFirstStart)
  return (
    <div className="panel">
      {' '}
      <div className="prow">
        <span>
          <div className="lbl">{t('settings.maintenance.settingsFile')}</div>
          <div className="sub">{t('settings.maintenance.settingsFileHint')}</div>
        </span>
      </div>
      <div className="prow">
        <span>
          <div className="lbl">{t('settings.maintenance.firstTimeSetup')}</div>
          <div className="sub">{t('settings.maintenance.firstTimeSetupHint')}</div>
        </span>
        <span className="spacer" />
        <Button onClick={() => setFirstStart(true)}>{t('settings.maintenance.replay')}</Button>
      </div>
    </div>
  )
}

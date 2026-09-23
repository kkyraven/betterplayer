import { useState } from 'react'
import { invoke } from '@/ipc'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { setStopOnPause } from '@/state/devices'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSettings } from '@/state/settings'
import { useSettingsNavigation } from '@/state/settingsNavigation'
import { useUi } from '@/state/ui'
import { ServerDialog } from '../library/ServerDialog'
import { SettingsLink } from './SettingsSection'

export function MediaCentreSettings() {
  const t = useT()
  const tv = useSettings((s) => s.settings?.tv)
  const reduce = useSettings((s) => s.settings?.appearance.reduceTransparency ?? false)
  const update = useSettings((s) => s.update)
  return (
    <div className="panel">
      <div className="prow">
        <span className="lbl">{t('settings.mediaCentre.buttonHints')}</span>
        <span className="spacer" />
        <Switch label={t('settings.mediaCentre.buttonHints')} checked={tv?.hints ?? true} onCheckedChange={(hints) => void update((s) => ({ ...s, tv: { ...s.tv, hints } }))} />
      </div>
      <div className="prow">
        <span>
          <span className="lbl">{t('settings.mediaCentre.backdrop')}</span>
          <span className="sub">{reduce ? t('settings.appearance.reduceTransparency') : t('settings.mediaCentre.backdropHint')}</span>
        </span>
        <span className="spacer" />
        <Switch label={t('settings.mediaCentre.backdrop')} checked={tv?.backdrop ?? false} disabled={reduce} onCheckedChange={(backdrop) => void update((s) => ({ ...s, tv: { ...s.tv, backdrop } }))} />
      </div>
    </div>
  )
}
export function DeviceSettings() {
  const t = useT()
  const stop = useSettings((s) => s.settings?.devices.stopOnPause ?? true)
  return (
    <>
      <div className="panel">
        <div className="prow">
          <span>
            <span className="lbl">{t('settings.devices.stopOnPause')}</span>
            <span className="sub">{t('settings.devices.stopOnPauseHint')}</span>
          </span>
          <span className="spacer" />
          <Switch label={t('settings.devices.stopOnPause')} checked={stop} onCheckedChange={setStopOnPause} />
        </div>
      </div>
      <Button
        onClick={() => {
          useSettingsNavigation.setState({ returnScreen: 'devices', target: 'device-manager' })
          useUi.getState().setScreen('devices')
        }}
        data-setting="device-manager"
      >
        {t('settings.devices.manage')}
      </Button>
    </>
  )
}
export function SourcesSettings() {
  const t = useT()
  const [server, setServer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roots = useLibrary((s) => s.roots)
  const addRoot = useLibrary((s) => s.addRoot)
  const matchOtherFolders = useSettings((s) => s.settings?.library.matchOtherFolders ?? true)
  const stashPreviews = useSettings((s) => s.settings?.library.stashPreviews ?? true)
  const stashApp = useSettings((s) => s.settings?.library.stashApp ?? '')
  const update = useSettings((s) => s.update)
  const setStashApp = (stashApp: string) => void update((s) => ({ ...s, library: { ...s.library, stashApp } }))
  const chooseStashApp = async () => {
    const path = await invoke('dialog:openStashApp')
    if (path) setStashApp(path)
  }
  return (
    <div className="set-library">
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.sources.folders')}</span>
          <span className="spacer" />
          <Button onClick={() => void addRoot().catch((error: unknown) => setError(String(error)))}>{t('settings.sources.addFolder')}</Button>
          <Button onClick={() => useUi.getState().setScreen('library')}>{t('settings.sources.manageFolders')}</Button>
        </div>
        {roots
          .filter((root) => root.kind === 'folder')
          .map((root) => (
            <div className="prow" key={root.id}>
              <span className="sub">{root.path}</span>
            </div>
          ))}
        <div className="prow">
          <span className="lbl">{t('settings.sources.scriptMatching')}</span>
          <span className="spacer" />
          <span className="sub">{t('settings.sources.otherFolders')}</span>
          <Switch label={t('settings.sources.otherFolders')} checked={matchOtherFolders} onCheckedChange={(matchOtherFolders) => void update((s) => ({ ...s, library: { ...s.library, matchOtherFolders } }))} />
        </div>
        {error && (
          <div className="prow error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.sources.mediaServers')}</span>
          <span className="spacer" />
          <Button onClick={() => setServer(true)}>{t('settings.sources.addServer')}</Button>
          <Button onClick={() => useUi.getState().setScreen('library')}>{t('settings.sources.manageServers')}</Button>
        </div>
      </div>
      {(roots.some((root) => root.kind === 'stash') || stashApp) && <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.sources.stashPreviews')}</span>
          <span className="spacer" />
          <Switch label={t('settings.sources.stashPreviews')} checked={stashPreviews} onCheckedChange={(stashPreviews) => void update((s) => ({ ...s, library: { ...s.library, stashPreviews } }))} />
        </div>
        <div className="prow">
          <span>
            <span className="lbl">{t('settings.sources.stashApp')}</span>
            {stashApp && <span className="sub">{stashApp}</span>}
          </span>
          <span className="spacer" />
          <Button onClick={() => void chooseStashApp()}>{stashApp ? t('tv.hints.change') : t('settings.sources.stashAppChoose')}</Button>
          {stashApp && <Button onClick={() => setStashApp('')}>{t('common.remove')}</Button>}
        </div>
      </div>}
      <SettingsLink page="source" />
      <ServerDialog open={server} onOpenChange={setServer} />
    </div>
  )
}
export function TechnicalSettings() {
  return (
    <div>
      {(['video', 'axes', 'estim', 'tracking', 'models', 'sharing', 'tagging'] as const).map((page) => (
        <SettingsLink key={page} page={page} advanced />
      ))}
    </div>
  )
}

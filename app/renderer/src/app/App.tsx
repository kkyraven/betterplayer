import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { bindingAction, dispatch, isCapturingBinding, keyboardKey, setBindings } from '@/input/actions'
import { installGamepadActions } from '@/input/gamepad'
import { spaceIsClaimed } from '@/input/keyboard'
import { cx } from '@/lib/cx'
import { isAdmin } from '@shared/account'
import { isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useProfilePhoto } from '@/state/profilePhoto'
import { applyTheme, useSystemDark } from '@/state/theme'
import { AdminScreen } from '@/screens/admin/AdminScreen'
import { BrowserScreen } from '@/screens/browser/BrowserScreen'
import { DevicesScreen } from '@/screens/devices/DevicesScreen'
import { DeviceWizard } from '@/screens/devices/DeviceWizard'
import { EditorScreen } from '@/screens/editor/EditorScreen'
import { FirstStart } from '@/screens/firstStart/FirstStart'
import { GameScreen } from '@/screens/game/GameScreen'
import { AccountPanel } from '@/components/account/AccountPanel'
import { ProfilePhotoDialog } from '@/components/account/ProfilePhotoDialog'
import { SessionPanel } from '@/components/together/SessionPanel'
import { LibraryScreen } from '@/screens/library/LibraryScreen'
import { PlayerScreen } from '@/screens/player/PlayerScreen'
import { SessionScreen } from '@/screens/session/SessionScreen'
import { SettingsScreen } from '@/screens/settings/SettingsScreen'
import { UtilitiesScreen } from '@/screens/utilities/UtilitiesScreen'
import { Glass } from '@/components/ui/Glass'
import { Prompt } from '@/components/ui/Prompt'
import { useGame } from '@/state/game'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { TV_SHELL_KEYS } from '@/state/tvNav'
import { toastFor } from '@/screens/tv/TvToast'
import { useUi, type Screen } from '@/state/ui'
import { MediaCentreShell } from './MediaCentreShell'
import { NowPlayingStrip } from './NowPlayingStrip'
import { Rail } from './Rail'
import { TitleBar } from './TitleBar'
import { useWindowDrop } from './useWindowDrop'
import './shell.css'

const SCREEN_COMPONENTS: Record<Screen, ComponentType> = {
  library: LibraryScreen,
  player: PlayerScreen,
  session: SessionScreen,
  browser: BrowserScreen,
  game: GameScreen,
  editor: EditorScreen,
  devices: DevicesScreen,
  utilities: UtilitiesScreen,
  settings: SettingsScreen,
  admin: AdminScreen,
}

export function App() {
  const t = useT()
  const admin = useAccount((s) => isAdmin(s.status.me))
  const gameRunning = useGame((s) => s.running)
  const screen = useUi((s) => (gameRunning && s.screen !== 'settings' ? 'game' : s.screen === 'admin' && !admin ? 'library' : s.screen))
  const fullscreen = useUi((s) => s.fullscreen)
  const reduceTransparency = useUi((s) => s.reduceTransparency)
  const theme = useSettings((s) => s.settings?.appearance.theme)
  const premium = useAccount(isPremium)
  const systemDark = useSystemDark()
  const toggleFullscreen = useUi((s) => s.toggleFullscreen)
  const mediaCentre = useUi((s) => s.mediaCentre)
  const firstStart = useUi((s) => s.firstStart)
  const editingPhoto = useProfilePhoto((s) => s.userId !== null)
  const [askFolder, setAskFolder] = useState<string | null>(null)
  const dropPaths = useCallback((paths: string[]) => {
    void useLibrary.getState().addPaths(paths).then(({ play, ask }) => {
      if (play) void usePlayer.getState().open(play)
      setAskFolder(ask)
    })
  }, [])
  const dragging = useWindowDrop(dropPaths, !firstStart && !editingPhoto)

  const shortcuts = useSettings((s) => s.settings?.shortcuts)
  useEffect(() => {
    const onKey = () => { document.documentElement.dataset.input = 'keyboard' }
    const onPointer = () => { document.documentElement.dataset.input = 'pointer' }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
      delete document.documentElement.dataset.input
    }
  }, [])

  useEffect(() => {
    if (shortcuts) setBindings(shortcuts)
  }, [shortcuts])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || (e.target instanceof HTMLElement && e.target.isContentEditable)) return
      if (e.key === ' ' && !isCapturingBinding() && spaceIsClaimed(e)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.repeat && !e.key.startsWith('Arrow')) return
      if (useUi.getState().firstStart || useGame.getState().running) return
      const key = keyboardKey(e)
      if (useUi.getState().mediaCentre) {
        if (TV_SHELL_KEYS.has(e.key)) return
        const id = bindingAction(key)
        if (!id || id === 'Window.Fullscreen.Toggle') return
        if (!dispatch(key)) return
        e.preventDefault()
        const text = toastFor(id)
        if (text) useUi.getState().showTvToast(text)
        return
      }
      if (dispatch(key)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (mediaCentre) return
    return installGamepadActions((key) => !useGame.getState().running && dispatch(key))
  }, [mediaCentre])

  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-transparency', reduceTransparency)
  }, [reduceTransparency])

  useEffect(() => {
    if (theme) applyTheme(theme, !premium, systemDark)
  }, [theme, premium, systemDark])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useUi.getState().mediaCentre) void toggleFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, toggleFullscreen])

  const Current = SCREEN_COMPONENTS[screen]
  if (firstStart) return <FirstStart />
  if (mediaCentre && !gameRunning) return <MediaCentreShell />
  return (
    <div className={cx('window', fullscreen && 'is-fullscreen', gameRunning && 'game-running')}>
      {!fullscreen && <TitleBar />}
      {!fullscreen && <Rail />}
      {fullscreen && <AccountPanel floating />}
      <ProfilePhotoDialog />
      <main className="main">
        <div className="screen">
          <Current />
        </div>
        {screen !== 'player' && screen !== 'editor' && !gameRunning && <NowPlayingStrip />}
      </main>
      <DeviceWizard />
      <SessionPanel />
      <Prompt
        open={askFolder !== null}
        onOpenChange={(open) => !open && setAskFolder(null)}
        title={t('app.addFolder.title')}
        body={askFolder ?? ''}
        confirmLabel={t('common.add')}
        onConfirm={() => askFolder && void useLibrary.getState().addPaths([askFolder])}
      />
      {dragging && (
        <div className="drop-hint">
          <Glass strong className="drop-hint-card">
            {t('app.dropHint')}
          </Glass>
        </div>
      )}
    </div>
  )
}

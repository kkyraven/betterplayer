import { MonitorPlay, Power, X } from 'lucide-react'
import { TvDialog } from '@/components/tv/TvDialog'
import { invoke } from '@/ipc'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'

export function TvPowerMenu() {
  const t = useT()
  const setMediaCentre = useUi((s) => s.setMediaCentre)
  const setTvOverlay = useUi((s) => s.setTvOverlay)
  const quit = () => {
    usePlayer.getState().savePosition()
    void invoke('app:quit')
  }
  return (
    <TvDialog title={t('tv.powerMenu.title')}>
      <button type="button" data-nav-first onClick={() => setMediaCentre(false)}>
        <MonitorPlay />
        {t('tv.powerMenu.desktopMode')}
      </button>
      <button type="button" className="danger" onClick={quit}>
        <Power />
        {t('tv.powerMenu.quit')}
      </button>
      <button type="button" onClick={() => setTvOverlay('none')}>
        <X />
        {t('common.cancel')}
      </button>
    </TvDialog>
  )
}

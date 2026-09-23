import { create } from 'zustand'
import { IDLE_PLAYING, isRemoteMedia, mediaUrl, sourceBase, SYNC_SEEK_MS, syncRate, type PlayingState, type RemoteSourceStatus } from '@shared/peer'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { useLibrary } from './library'
import { onPlayback, usePlayer } from './player'
import { useSelect } from './select'
import { useSettings } from './settings'
import { useUi } from './ui'

const SYNC_MS = 100
const SEEK_SETTLE_MS = 600
const PAUSED_SEEK_MS = 15
const LEAVE_FULLSCREEN_MS = 1500

interface RemoteState {
  status: RemoteSourceStatus
  playing: PlayingState
  followed: string | null
  init: () => Promise<void>
}

export const useRemote = create<RemoteState>()((set, get) => {
  let receivedAt = 0
  let seekedAt = 0
  let lastRate = 0
  let wentFullscreen = false
  let leaveTimer = 0
  let syncTimer = 0
  let applying = false

  const drive = (action: () => void) => {
    applying = true
    try {
      action()
    } finally {
      applying = false
    }
  }

  const target = () => {
    const { playing } = get()
    return playing.playing ? playing.timeMs + (performance.now() - receivedAt) * playing.rate : playing.timeMs
  }

  const sync = () => {
    const { followed, playing } = get()
    const player = usePlayer.getState()
    if (!followed || player.path !== followed || !player.snapshot.loaded) return
    const now = performance.now()
    try {
      if (playing.playing === player.snapshot.paused) drive(() => (playing.playing ? player.play() : player.pause()))
      if (now - seekedAt < SEEK_SETTLE_MS) return
      const drift = engine.state().timeMs - target()
      if (Math.abs(drift) > (playing.playing ? SYNC_SEEK_MS : PAUSED_SEEK_MS)) {
        seekedAt = now
        drive(() => player.seek(target() / 1000))
        setRate(playing.rate)
        return
      }
      setRate(playing.playing ? syncRate(playing.rate, drift) : playing.rate)
    } catch (e) {
      console.debug(`follow: ${String(e)}`)
    }
  }

  const setRate = (rate: number) => {
    if (rate === lastRate) return
    lastRate = rate
    engine.setRate(rate)
  }

  const stopFollowing = () => {
    const { followed } = get()
    const player = usePlayer.getState()
    if (followed && player.path === followed) drive(() => player.close())
    if (wentFullscreen) {
      window.clearTimeout(leaveTimer)
      leaveTimer = window.setTimeout(() => {
        wentFullscreen = false
        void useUi.getState().toggleFullscreen(false)
      }, LEAVE_FULLSCREEN_MS)
    }
    window.clearInterval(syncTimer)
    lastRate = 0
    set({ followed: null })
  }

  const startFollowing = (url: string) => {
    window.clearTimeout(leaveTimer)
    window.clearInterval(syncTimer)
    syncTimer = window.setInterval(sync, SYNC_MS)
    lastRate = 0
    seekedAt = performance.now()
    set({ followed: url })
  }

  const sourceChanged = () => {
    const player = usePlayer.getState()
    if (get().followed) stopFollowing()
    else if (player.path && isRemoteMedia(player.path)) player.close()
    useSelect.getState().clear()
    useLibrary.setState({ section: 'all', folder: null, playlistId: null, search: '', filters: {}, rows: [], continueRows: [], total: 0, rev: null, selectedId: null, detail: null })
    const library = useLibrary.getState()
    void library.refresh()
    void library.query('reset')
  }

  const follow = async (state: PlayingState) => {
    receivedAt = performance.now()
    set({ playing: state })
    const { status, followed } = get()
    if (!status.source || !useSettings.getState().settings?.remote.follow) return
    if (state.mediaId === null) {
      if (followed) stopFollowing()
      return
    }
    const url = mediaUrl(sourceBase(status.source), state.mediaId)
    if (url === followed) {
      sync()
      return
    }
    const ui = useUi.getState()
    if (!ui.fullscreen && !ui.mediaCentre) {
      wentFullscreen = true
      void ui.toggleFullscreen(true)
    }
    startFollowing(url)
    applying = true
    try {
      await usePlayer.getState().open(url, target() / 1000)
    } finally {
      applying = false
    }
    seekedAt = performance.now()
    if (!state.playing && get().followed === url) drive(() => usePlayer.getState().pause())
  }

  return {
    status: { source: '', connected: false, error: null },
    playing: IDLE_PLAYING,
    followed: null,
    init: async () => {
      const [status, playing] = await Promise.all([invoke('remote:source'), invoke('remote:playing')])
      set({ status })
      on('remote:source', (next) => {
        const changed = next.source !== get().status.source
        set({ status: next })
        if (changed) sourceChanged()
      })
      on('remote:playing', (state) => void follow(state))
      onPlayback((command) => {
        if (applying || !get().status.source || !useSettings.getState().settings?.remote.follow) return
        if (command.kind === 'open') startFollowing(mediaUrl(sourceBase(get().status.source), command.mediaId))
        else if (!get().followed) return
        void invoke('player:control', command)
      })
      void follow(playing)
    },
  }
})

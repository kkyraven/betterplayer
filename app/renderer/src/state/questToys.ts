import { isAxisId } from '@shared/axes'
import { mediaIdFromUrl } from '@shared/peer'
import type { QuestToys } from '@shared/quest'
import { isUrl } from '@shared/remote'
import type { PerVideoSettings } from '@shared/settings'
import { invoke, on } from '@/ipc'
import { applyVideoToEngine } from './axisDefaults'
import { useDevices } from './devices'
import { useEstimAudio } from './estimAudio'
import { useFollow } from './follow'
import { applyDeviceCommand, estimLevels, toyOutputs, videoToys, withToyCommand } from './headsetToys'
import * as live from './live'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { useTracking } from './tracking'

const EMPTY_VIDEO: PerVideoSettings = { globalOffsetMs: 0, axes: {} }
const SAVE_MS = 300

export function startQuestToys() {
  let followed: { mediaId: number; path: string; video: PerVideoSettings } | null = null
  let reads = 0
  let sent = ''
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSave: (() => void) | null = null

  const followedHost = () => {
    const { kind, host, state } = useFollow.getState()
    return kind === 'quest' && state !== null ? host : null
  }
  const scripted = () => live.axisIdsWith(live.FLAG_SCRIPT).filter(isAxisId)
  const shown = () => live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_DERIVED).filter(isAxisId)
  const defaults = () => useSettings.getState().settings?.axesDefault
  const tracking = (path: string) => {
    const { source, key } = useTracking.getState()
    return source === 'headset' && key === path
  }

  const publish = () => {
    const toys: QuestToys = {
      outputs: toyOutputs(),
      video: followed ? { mediaId: followed.mediaId, ...videoToys(followed.video, shown(), defaults()), tracking: isUrl(followed.path) ? undefined : tracking(followed.path) } : null,
      estim: estimLevels(),
    }
    const host = followedHost()
    const json = JSON.stringify([toys, host])
    if (json === sent) return
    sent = json
    void invoke('remote:toys', toys, host)
  }

  const flushSave = () => {
    clearTimeout(saveTimer)
    pendingSave?.()
    pendingSave = null
  }
  const save = (path: string, video: PerVideoSettings) => {
    clearTimeout(saveTimer)
    pendingSave = () => {
      void invoke('video:get', path).then((stored) => invoke('video:set', path, { ...(stored ?? EMPTY_VIDEO), axes: video.axes, globalOffsetMs: video.globalOffsetMs }))
    }
    saveTimer = setTimeout(flushSave, SAVE_MS)
  }

  const drop = () => {
    reads++
    flushSave()
    followed = null
  }
  const match = async () => {
    drop()
    const token = reads
    const { kind, state, matched } = useFollow.getState()
    const mediaId = state?.path ? mediaIdFromUrl(state.path) : null
    if (kind === 'quest' && matched && mediaId !== null) {
      const video = (await invoke('video:get', matched.path)) ?? EMPTY_VIDEO
      if (token !== reads) return
      followed = { mediaId, path: matched.path, video }
    }
    publish()
  }

  useFollow.subscribe((s, prev) => {
    if (s.matched !== prev.matched) void match()
    else if (s.state?.path !== prev.state?.path || s.kind !== prev.kind || s.host !== prev.host) {
      drop()
      publish()
    }
  })
  useDevices.subscribe((s, prev) => {
    if (s.outputs !== prev.outputs || s.states !== prev.states) publish()
  })
  useSettings.subscribe((s, prev) => {
    if (s.settings?.axesDefault !== prev.settings?.axesDefault || s.settings?.estim !== prev.settings?.estim) publish()
  })
  useEstimAudio.subscribe((s, prev) => {
    if (s.state.status !== prev.state.status) publish()
  })
  usePlayer.subscribe((s, prev) => {
    if (s.snapshot.flagsVersion !== prev.snapshot.flagsVersion) publish()
  })
  useTracking.subscribe((s, prev) => {
    if (s.source !== prev.source || s.key !== prev.key) publish()
  })

  on('headset:toys', (command) => {
    if (command.kind === 'reconnect') return applyDeviceCommand(command)
    if (followedHost() !== command.host) return
    if (command.kind === 'restimVolume' || command.kind === 'audioVolume' || command.kind === 'coyote') return applyDeviceCommand(command)
    if (!followed || followed.mediaId !== command.mediaId) return
    if (command.kind === 'tracking') return useTracking.getState().switchHeadset(command.on)
    const { intensity } = videoToys(followed.video, shown(), defaults())
    const video = withToyCommand(followed.video, command, scripted(), intensity, defaults())
    applyVideoToEngine(video)
    followed = { ...followed, video }
    save(followed.path, video)
    publish()
  })
  publish()
}

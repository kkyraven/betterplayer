import { isAxisId, type AxisId } from '@shared/axes'
import { mediaIdFromUrl } from '@shared/peer'
import type { QuestToyCommand, QuestToys } from '@shared/quest'
import { defaultAxisSettings, type PerVideoSettings, type Settings } from '@shared/settings'
import { invoke, on } from '@/ipc'
import { applyVideoToEngine } from './axisDefaults'
import { outputName, useDevices, type ConfiguredOutput } from './devices'
import { useFollow } from './follow'
import * as live from './live'
import { usePlayer } from './player'
import { useSettings } from './settings'

type VideoToys = NonNullable<QuestToys['video']>
type Defaults = Settings['axesDefault'] | undefined

const EMPTY_VIDEO: PerVideoSettings = { globalOffsetMs: 0, axes: {} }
const SAVE_MS = 300

const axisOf = (id: AxisId, video: PerVideoSettings, defaults: Defaults) => video.axes[id] ?? defaults?.[id] ?? defaultAxisSettings(id)
const outputId = (o: ConfiguredOutput) => o.config.id ?? String(o.id)

export function videoToys(mediaId: number, video: PerVideoSettings, shown: AxisId[], defaults: Defaults): VideoToys {
  const first = shown[0]
  return { mediaId, intensity: first ? axisOf(first, video, defaults).amplitude : 1, offsetMs: video.globalOffsetMs }
}

export function withToyCommand(video: PerVideoSettings, command: Exclude<QuestToyCommand, { kind: 'reconnect' }>, scripted: AxisId[], intensity: number, defaults: Defaults): PerVideoSettings {
  if (command.kind === 'offset') return { ...video, globalOffsetMs: command.ms }
  const step = command.value - intensity
  const axes = { ...video.axes }
  for (const id of scripted) {
    const current = axisOf(id, video, defaults)
    axes[id] = { ...current, amplitude: Math.max(0, Math.round((current.amplitude + step) * 100) / 100) }
  }
  return { ...video, axes }
}

export function startQuestToys() {
  let followed: { mediaId: number; path: string; video: PerVideoSettings } | null = null
  let reads = 0
  let sent = ''
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSave: (() => void) | null = null

  const scripted = () => live.axisIdsWith(live.FLAG_SCRIPT).filter(isAxisId)
  const shown = () => live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_DERIVED).filter(isAxisId)
  const defaults = () => useSettings.getState().settings?.axesDefault

  const publish = () => {
    const { outputs, states } = useDevices.getState()
    const toys: QuestToys = {
      outputs: outputs.map((o) => ({ id: outputId(o), name: outputName(o.config), connected: states[o.id]?.status === 'connected' })),
      video: followed ? videoToys(followed.mediaId, followed.video, shown(), defaults()) : null,
    }
    const { kind, host: followHost } = useFollow.getState()
    const host = kind === 'quest' ? followHost : null
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
    if (s.settings?.axesDefault !== prev.settings?.axesDefault) publish()
  })
  usePlayer.subscribe((s, prev) => {
    if (s.snapshot.flagsVersion !== prev.snapshot.flagsVersion) publish()
  })

  on('headset:toys', (command) => {
    if (command.kind === 'reconnect') {
      const output = useDevices.getState().outputs.find((o) => outputId(o) === command.id)
      if (output) useDevices.getState().reconnect(output.id)
      return
    }
    const { kind, host } = useFollow.getState()
    if (!followed || kind !== 'quest' || host !== command.host || followed.mediaId !== command.mediaId) return
    const axes = scripted()
    const { intensity } = videoToys(followed.mediaId, followed.video, shown(), defaults())
    const video = withToyCommand(followed.video, command, axes, intensity, defaults())
    applyVideoToEngine(video)
    followed = { ...followed, video }
    save(followed.path, video)
    publish()
  })
  publish()
}

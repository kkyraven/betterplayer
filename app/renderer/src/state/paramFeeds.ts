import { PARAM_AXES } from '@shared/settings'
import { defaultTrackingDefaults } from '@shared/tracking'
import { engine } from '@/engine/client'
import { ensureAudio, releaseAudio } from './audio'
import { feedColour, useBrowser } from './browser'
import { useDevices } from './devices'
import { effectiveParam } from './params'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { useTracking } from './tracking'

let unsubscribe: (() => void) | null = null
let lastKey = ''

function sync() {
  const outputs = useDevices.getState().outputs
  const paramsOn = useSettings.getState().settings?.estim.params ?? false
  const sources = paramsOn && outputs.some((o) => o.config.profile === 'restim') ? PARAM_AXES.map((axis) => effectiveParam(axis).source) : []
  const wantsAudio = sources.includes('audio')
  const wantsDetection = sources.includes('detection')
  const path = usePlayer.getState().path
  const tracking = useTracking.getState().source
  const tab = useBrowser.getState().activeId
  const key = [wantsAudio, wantsDetection, path, tracking, tab].join('|')
  if (key === lastKey) return
  lastKey = key

  if (wantsAudio && path) ensureAudio(path, 'parameters').catch((e: unknown) => console.debug(`audio for parameters: ${String(e)}`))
  else releaseAudio('parameters')

  if (wantsDetection) void useTracking.getState().refreshModels()
  const feedBrowser = wantsDetection && tracking === null && tab !== null
  if (feedBrowser && !unsubscribe) {
    unsubscribe = feedColour(() => (engine.wantsFrames() ? (useSettings.getState().settings?.tracking ?? defaultTrackingDefaults()).detectEveryMs : null))
  } else if (!feedBrowser && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

useDevices.subscribe(sync)
useSettings.subscribe(sync)
usePlayer.subscribe(sync)
useTracking.subscribe(sync)
useBrowser.subscribe(sync)

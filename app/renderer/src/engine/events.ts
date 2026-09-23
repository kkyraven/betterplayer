import type { EngineState, OutputState } from 'bp-engine'
import { engine } from './client'
import { invoke } from '@/ipc'
import { useDevices } from '@/state/devices'
import '@/state/paramFeeds'
import { useFollow } from '@/state/follow'
import { autoSkipGap } from '@/state/gapSkip'
import * as live from '@/state/live'
import { useSession } from '@/state/session'
import { useTracking } from '@/state/tracking'
import { useUi } from '@/state/ui'
import { onDeviceInput } from '@/input/actions'
import { END_WINDOW_MS, usePlayer, type PlayerSnapshot } from '@/state/player'

const TRACK_POLL_MS = 1000 / 30

const sameSnapshot = (a: EngineState, b: EngineState) =>
  a.durationMs === b.durationMs &&
  a.paused === b.paused &&
  a.loaded === b.loaded &&
  a.rate === b.rate &&
  a.flagsVersion === b.flagsVersion &&
  a.videoWidth === b.videoWidth &&
  a.videoHeight === b.videoHeight &&
  a.error === b.error

const sameOutput = (a: OutputState, b: OutputState) =>
  a.id === b.id &&
  a.profile === b.profile &&
  a.status === b.status &&
  a.error === b.error &&
  a.device === b.device &&
  a.tcode === b.tcode &&
  a.ramp?.value === b.ramp?.value &&
  Math.round((a.ramp?.elapsedMs ?? -1) / 1000) === Math.round((b.ramp?.elapsedMs ?? -1) / 1000) &&
  a.battery === b.battery &&
  a.features.length === b.features.length &&
  a.features.every((f, i) => f.index === b.features[i]?.index && f.axis === b.features[i]?.axis)

const sameOutputs = (a: OutputState[], b: OutputState[]) =>
  a.length === b.length &&
  a.every((output, i) => {
    const other = b[i]
    return other !== undefined && sameOutput(output, other)
  })

function toSnapshot(s: EngineState): PlayerSnapshot {
  return { durationMs: s.durationMs, paused: s.paused, loaded: s.loaded, rate: s.rate, flagsVersion: s.flagsVersion, videoWidth: s.videoWidth, videoHeight: s.videoHeight, error: s.error ?? null }
}

export function startEngineEvents(): () => void {
  let previous: EngineState | null = null
  let lastTrackPoll = 0
  let handle = 0
  const tick = () => {
    handle = requestAnimationFrame(tick)
    const state = engine.state()
    live.set(state)
    if (!previous || !sameSnapshot(previous, state)) usePlayer.getState().setSnapshot(toSnapshot(state))
    if (!previous || previous.paused !== state.paused) void invoke('window:playing', !state.paused)
    autoSkipGap(state)
    if (previous && !previous.paused && state.paused) {
      const requested = usePlayer.getState().takePauseRequest()
      const atEnd =
        !requested &&
        state.loaded &&
        !state.following &&
        state.durationMs > END_WINDOW_MS &&
        state.timeMs >= state.durationMs - END_WINDOW_MS
      if (atEnd) usePlayer.getState().markEnded()
      const ui = useUi.getState()
      const playerShown = ui.mediaCentre ? ui.tvTab === 'nowplaying' : ui.screen === 'player'
      if (atEnd && useSession.getState().stage !== 'running' && (playerShown || usePlayer.getState().playlist !== null)) {
        void usePlayer.getState().onEnded()
      }
    }
    if (!previous || !sameOutputs(previous.outputs, state.outputs)) useDevices.getState().setStates(state.outputs)
    if (state.following || useFollow.getState().state) useFollow.getState().update(state.following ? engine.followState() : null)
    for (const input of engine.takeInputs()) onDeviceInput(input.output, input.name)
    if (useTracking.getState().source) {
      const now = performance.now()
      if (now - lastTrackPoll >= TRACK_POLL_MS) {
        lastTrackPoll = now
        useTracking.getState().update(engine.trackState())
      }
    }
    previous = state
  }
  handle = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(handle)
}

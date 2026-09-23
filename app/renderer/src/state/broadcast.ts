import { IDLE_PLAYING, isRemoteMedia, type PlayerCommand, type PlayingState } from '@shared/peer'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { onPlayback, usePlayer } from './player'

const TICK_MS = 250
const RESEND_MS = 1000
const JUMP_MS = 200
const IDLE_TICKS = 2

function current(): PlayingState {
  const { media, path, snapshot } = usePlayer.getState()
  if (!media || !path || !snapshot.loaded || isRemoteMedia(path)) return IDLE_PLAYING
  return { mediaId: media.id, playing: !snapshot.paused, timeMs: engine.state().timeMs, durationMs: snapshot.durationMs, rate: snapshot.rate }
}

async function apply(command: PlayerCommand) {
  const player = usePlayer.getState()
  switch (command.kind) {
    case 'play':
      return player.play()
    case 'pause':
      return player.pause()
    case 'seek':
      return player.seek(command.timeMs / 1000)
    case 'rate':
      return player.setRate(command.rate)
    case 'open': {
      const detail = await invoke('library:media', command.mediaId)
      if (detail) await player.open(detail.path)
    }
  }
}

export async function startBroadcast() {
  let running = (await invoke('remote:status')).running
  on('remote:status', (status) => {
    running = status.running
  })
  let last = IDLE_PLAYING
  let sentAt = 0
  let idleTicks = 0
  const publish = (force: boolean) => {
    if (!running) return
    const state = current()
    if (state.mediaId === null && last.mediaId !== null && !force && ++idleTicks < IDLE_TICKS) return
    idleTicks = 0
    const now = performance.now()
    const elapsed = now - sentAt
    const expected = last.playing ? last.timeMs + elapsed * last.rate : last.timeMs
    const moved = state.mediaId !== last.mediaId || state.playing !== last.playing || state.rate !== last.rate || Math.abs(state.timeMs - expected) > JUMP_MS
    if (!force && !moved && !(state.playing && elapsed >= RESEND_MS)) return
    last = state
    sentAt = now
    void invoke('remote:publish', state)
  }
  setInterval(() => publish(false), TICK_MS)
  onPlayback(() => publish(true))
  usePlayer.subscribe((s, prev) => {
    if (s.snapshot.paused !== prev.snapshot.paused || s.snapshot.rate !== prev.snapshot.rate || s.snapshot.loaded !== prev.snapshot.loaded || s.media !== prev.media) publish(true)
  })
  on('player:control', (command) => {
    if (running) void apply(command)
  })
}

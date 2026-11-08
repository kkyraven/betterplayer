// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { portalPath, readPortalHeaders } from '@shared/portals'
import { engine } from '@/engine/client'
import * as live from '@/state/live'
import { onPlayback, usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'
import type { DomRange } from './clips'

export interface StageVideo {
  path: string
  title: string
  mediaId: number | null
  loaded: boolean
  paused: boolean
  timeMs: number
  durationMs: number
  rate: number
  seekGeneration: number
  ended: boolean
}

export interface StageFrame {
  url: string
  timeMs: number
  path: string
}

export interface StageWatch {
  ranges: () => void
  changed: (now: StageVideo | null, was: StageVideo | null) => void
  clock: (now: StageVideo) => void
  ended: () => void
}

export interface DomStage {
  video: () => StageVideo | null
  generation: () => number
  open: (path: string, mediaId: number, range: DomRange, signal: AbortSignal) => Promise<void>
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  frame: () => Promise<StageFrame | null>
  clearEnd: () => void
  halted: () => void
  show: () => void
  watch: (w: StageWatch) => () => void
}

const playerVideo = (p: ReturnType<typeof usePlayer.getState>, { timeMs, seekGeneration, playbackEnded } = live.get()): StageVideo | null => {
  if (!p.path) return null
  return { path: p.path, title: p.title, mediaId: p.media?.id ?? null, loaded: p.snapshot.loaded, paused: p.snapshot.paused, timeMs, durationMs: p.snapshot.durationMs, rate: p.snapshot.rate, seekGeneration, ended: playbackEnded }
}

export const windowStage: DomStage = {
  video: () => playerVideo(usePlayer.getState()),
  generation: () => engine.state().seekGeneration,
  open: async (path, _mediaId, range, signal) => {
    await usePlayer.getState().open(path, range.start_seconds, undefined, true, signal, undefined, range.end_seconds)
  },
  play: () => usePlayer.getState().play(),
  pause: () => usePlayer.getState().pause(),
  seek: (seconds) => usePlayer.getState().seek(seconds),
  frame: async () => {
    const { captureVideo } = await import('@/components/player/stage')
    return captureVideo()
  },
  clearEnd: () => engine.clearPlaybackEnd(),
  halted: () => {},
  show: () => useUi.getState().setScreen('player'),
  watch: (w) => {
    const offs = [
      usePlayer.subscribe((s, prev) => {
        if (s.video !== prev.video || s.path !== prev.path) w.ranges()
        w.changed(playerVideo(s), playerVideo(prev))
      }),
      onPlayback((command) => {
        if (command.kind === 'play') w.ranges()
      }),
      useSettings.subscribe((s, prev) => {
        if (s.settings?.axesDefault !== prev.settings?.axesDefault) w.ranges()
      }),
      live.subscribe((l) => {
        const p = usePlayer.getState()
        if (p.path && p.snapshot.loaded && p.snapshot.durationMs === l.durationMs) {
          const now = playerVideo(p, l)
          if (now) w.clock(now)
        }
      }),
    ]
    return () => offs.forEach((off) => off())
  },
}


export async function stillFrame(video: StageVideo): Promise<StageFrame | null> {
  if (video.mediaId === null) return null
  const res = await fetch(`thumb://${portalPath(video.mediaId, 1024, video.timeMs)}`)
  const info = readPortalHeaders((name) => res.headers.get(name))
  if (res.status !== 200 || !info || info.kind === 'blank') return null
  const blob = await res.blob()
  const url = await new Promise<string>((done, fail) => {
    const reader = new FileReader()
    reader.onload = () => done(String(reader.result))
    reader.onerror = () => fail(new Error('still'))
    reader.readAsDataURL(blob)
  })
  return { url, timeMs: video.timeMs, path: video.path }
}

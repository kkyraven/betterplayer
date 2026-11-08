// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { mediaIdFromUrl } from '@shared/peer'
import type { QuestDomCommand } from '@shared/quest'
import type { DomStage, StageVideo, StageWatch } from '@/dom/stage'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { headsetDom, useDom } from './dom'
import { useFollow } from './follow'
import { isSubscriber, useAccount } from './account'
import { usePlayer } from './player'
import { useSettings } from './settings'

const COMMANDS_KEPT = 16
const OPEN_WAIT_MS = 15_000
const END_MS = 500
const OPEN_SLACK_MS = 5_000
export const QUEST_GONE_MS = 120_000
const GONE_CHECK_MS = 5_000
const RELEASE_MS = 12_000

type Command = QuestDomCommand extends infer C ? (C extends QuestDomCommand ? Omit<C, 'n'> : never) : never

export function questStage(host: string, send: (command: Command) => void): DomStage {
  const paths = new Map<number, string>()
  let generation = 0
  let opening: { mediaId: number; startMs: number; moved: boolean; shown: () => void } | null = null

  const video = (): StageVideo | null => {
    const { state, matched, kind, host: followed } = useFollow.getState()
    if (!state?.path || kind !== 'quest' || followed !== host) return null
    const mediaId = mediaIdFromUrl(state.path)
    const known = mediaId === null ? undefined : paths.get(mediaId)
    return {
      path: known ?? matched?.path ?? state.path,
      title: matched?.title ?? '',
      mediaId,
      loaded: state.status === 'connected',
      paused: !state.playing,
      timeMs: state.timeMs,
      durationMs: state.durationMs,
      rate: state.rate,
      seekGeneration: generation,
      ended: !state.playing && state.durationMs > 0 && state.timeMs >= state.durationMs - END_MS,
    }
  }

  const checkOpened = (now: StageVideo | null) => {
    if (!opening || now?.mediaId !== opening.mediaId) return
    if (opening.moved || Math.abs(now.timeMs - opening.startMs) <= OPEN_SLACK_MS) opening.shown()
  }

  return {
    video,
    generation: () => generation,
    open: (path, mediaId, range, signal) =>
      new Promise((done) => {
        paths.set(mediaId, path)
        const startMs = Math.round(range.start_seconds * 1000)
        const shown = () => {
          window.clearTimeout(timer)
          signal.removeEventListener('abort', shown)
          opening = null
          generation++
          done()
        }
        const timer = window.setTimeout(shown, OPEN_WAIT_MS)
        signal.addEventListener('abort', shown)
        opening = { mediaId, startMs, moved: video()?.mediaId !== mediaId, shown }
        send({ kind: 'open', mediaId, startMs })
      }),
    play: () => send({ kind: 'play' }),
    pause: () => send({ kind: 'pause' }),
    seek: (seconds) => send({ kind: 'seek', ms: Math.round(seconds * 1000) }),
    frame: () => Promise.resolve(null),
    clearEnd: () => {},
    halted: () => useFollow.setState({ halted: { host, path: useFollow.getState().state?.path ?? null } }),
    show: () => {},
    watch: (w: StageWatch) => {
      let was = video()
      const offToys = on('headset:toys', () => w.ranges())
      const offSettings = useSettings.subscribe((s, prev) => {
        if (s.settings?.axesDefault !== prev.settings?.axesDefault) w.ranges()
      })
      const offFollow = useFollow.subscribe((s, prev) => {
        if (s.matched !== prev.matched) w.ranges()
        const now = video()
        checkOpened(now)
        if (now?.ended && !was?.ended) w.ended()
        w.changed(now, was)
        if (now?.loaded) w.clock(now)
        was = now
      })
      return () => {
        offToys()
        offSettings()
        offFollow()
      }
    },
  }
}

export function startQuestDom() {
  let host: string | null = null
  let commands: QuestDomCommand[] = []
  let n = 0
  let sent = ''
  let goneTimer = 0
  let seenAt = 0

  const publish = () => {
    const dom = useDom.getState()
    const shown = headsetDom(dom)
    const state = host === null && dom.running ? { ...shown, doms: [], session: null } : shown
    const json = JSON.stringify([state, commands, host])
    if (json === sent) return
    sent = json
    void invoke('remote:dom', state, commands, host)
  }

  const send = (command: Command) => {
    commands = [...commands, { ...command, n: ++n } as QuestDomCommand].slice(-COMMANDS_KEPT)
    publish()
  }

  const watchHeadset = (running: string) => {
    seenAt = Date.now()
    window.clearInterval(goneTimer)
    goneTimer = window.setInterval(() => {
      const { state, kind, host: followed } = useFollow.getState()
      if (kind === 'quest' && followed === running && state?.status === 'connected') seenAt = Date.now()
      else if (Date.now() - seenAt >= QUEST_GONE_MS) useDom.getState().halt()
    }, GONE_CHECK_MS)
  }

  useDom.subscribe(publish)
  useAccount.subscribe((s, prev) => {
    if (useDom.getState().loaded && isSubscriber(s) !== isSubscriber(prev)) void useDom.getState().refreshAccount()
    publish()
  })
  on('headset:domAsk', () => {
    if (!useDom.getState().loaded) void useDom.getState().load().catch((error: unknown) => console.warn(`dom: ${String(error)}`))
  })

  on('headset:dom', (request) => {
    const dom = useDom.getState()
    if (request.kind === 'send') {
      if (host === request.host) dom.send(request.text)
      return
    }
    if (dom.running) return
    host = request.host
    if (useFollow.getState().halted) {
      engine.resumeSensation()
      useFollow.setState({ halted: null })
    }
    if (usePlayer.getState().path) usePlayer.getState().pause()
    watchHeadset(request.host)
    dom.setHeadset(true)
    void dom.start(request.domId, questStage(request.host, send)).then(() => {
      if (!useDom.getState().running) ended()
    })
  })

  const ended = () => {
    if (host === null || useDom.getState().running) return
    window.clearInterval(goneTimer)
    useDom.getState().setHeadset(false)
    host = null
    commands = []
    publish()
  }

  useDom.subscribe((s, prev) => {
    if (prev.running && !s.running && host !== null) window.setTimeout(ended, RELEASE_MS)
  })

  const lost = ({ host: from }: { host: string }) => {
    if (from === host) useDom.getState().halt()
  }
  on('headset:stop', lost)
  on('headset:bye', lost)

  publish()
}

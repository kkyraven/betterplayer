// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { release } from 'node:os'
import { desktopCapturer, shell, systemPreferences, type BrowserWindow } from 'electron'
import { supportsGameSystemAudio, type GameSource, type GameSources } from '@shared/game'

const THUMBNAIL = { width: 320, height: 180 }
const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export class GameCapture {
  private picked: string | null = null
  private generation = 0

  constructor(private readonly win: BrowserWindow) {
    win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const id = this.picked
      if (!id || win.isDestroyed() || request.frame !== win.webContents.mainFrame || !request.videoRequested) {
        callback({})
        return
      }
      this.picked = null
      const generation = this.generation
      void desktopCapturer
        .getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const video = sources.find((s) => s.id === id)
          if (!video || generation !== this.generation || win.isDestroyed() || request.frame !== win.webContents.mainFrame || video.id === win.getMediaSourceId()) {
            callback({})
            return
          }
          callback({ video, ...(request.audioRequested && supportsGameSystemAudio(process.platform, release()) ? { audio: 'loopback' as const } : {}) })
        })
        .catch(() => callback({}))
    })
  }

  async sources(): Promise<GameSources> {
    const screenAccess = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') === 'granted' : true
    const own = this.win.getMediaSourceId()
    let sources: GameSource[] = []
    try {
      const found = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: THUMBNAIL })
      sources = found
        .filter((s) => s.id !== own && s.name.trim() !== '')
        .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }))
    } catch {
    }
    return { sources, screenAccess }
  }

  pick(id: string | null) {
    this.generation++
    this.picked = id
  }

  openScreenAccess() {
    return process.platform === 'darwin' ? shell.openExternal(SCREEN_RECORDING_PANE) : Promise.resolve()
  }
}

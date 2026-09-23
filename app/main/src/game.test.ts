// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { BrowserWindow, DesktopCapturerSource, DisplayMediaRequestHandlerHandlerRequest, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameCapture } from './game'

const native = vi.hoisted(() => ({ sources: vi.fn(), handler: vi.fn(), access: vi.fn(), release: vi.fn(() => '25.0.0') }))
vi.mock('node:os', () => ({ release: native.release }))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: native.sources },
  systemPreferences: { getMediaAccessStatus: native.access },
  shell: { openExternal: vi.fn() },
}))

function source(id: string, name = 'Game'): DesktopCapturerSource {
  return { id, name, thumbnail: { isEmpty: () => false, toDataURL: () => 'thumbnail' } } as DesktopCapturerSource
}

function setup() {
  const frame = {} as Electron.WebFrameMain
  const win = {
    isDestroyed: vi.fn(() => false),
    getMediaSourceId: () => 'window:own',
    webContents: { mainFrame: frame, session: { setDisplayMediaRequestHandler: native.handler } },
  }
  const game = new GameCapture(win as unknown as BrowserWindow)
  const handler = native.handler.mock.calls[0]![0] as NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
  const request = (overrides: Partial<DisplayMediaRequestHandlerHandlerRequest> = {}) => {
    const callback = vi.fn()
    handler({ frame, videoRequested: true, audioRequested: false, securityOrigin: 'file://', userGesture: true, ...overrides }, callback)
    return callback
  }
  return { game, request, win }
}

beforeEach(() => {
  vi.clearAllMocks()
  native.sources.mockResolvedValue([source('window:game')])
  native.access.mockReturnValue('granted')
})

describe('game capture', () => {
  it('grants one video request from the app after a source is selected', async () => {
    const { game, request } = setup()
    game.pick('window:game')
    const callback = request()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: expect.objectContaining({ id: 'window:game' }) }))
    expect(request()).toHaveBeenCalledWith({})
    expect(native.sources).toHaveBeenCalledOnce()
  })

  it('rejects another frame without consuming the app selection', async () => {
    const { game, request } = setup()
    game.pick('window:game')
    expect(request({ frame: null })).toHaveBeenCalledWith({})
    const callback = request()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: expect.objectContaining({ id: 'window:game' }) }))
  })

  it('rejects a capture cancelled while sources are loading', async () => {
    let resolve!: (sources: DesktopCapturerSource[]) => void
    native.sources.mockReturnValue(new Promise<DesktopCapturerSource[]>((done) => { resolve = done }))
    const { game, request } = setup()
    game.pick('window:game')
    const callback = request()
    game.pick(null)
    resolve([source('window:game')])
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
  })

  it('rejects capture after the app window closes', async () => {
    const { game, request, win } = setup()
    game.pick('window:game')
    const callback = request()
    win.isDestroyed.mockReturnValue(true)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
  })

  it('excludes its own window from capture and source selection', async () => {
    native.sources.mockResolvedValue([source('window:own'), source('window:game'), source('window:blank', ' ')])
    const { game, request } = setup()
    expect((await game.sources()).sources).toEqual([{ id: 'window:game', name: 'Game', kind: 'window', thumbnail: 'thumbnail' }])
    game.pick('window:own')
    const callback = request()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
  })

  it('rejects capture if the source disappears or enumeration fails', async () => {
    const { game, request } = setup()
    game.pick('window:missing')
    const missing = request()
    await vi.waitFor(() => expect(missing).toHaveBeenCalledWith({}))
    native.sources.mockRejectedValue(new Error('Capture unavailable'))
    game.pick('window:game')
    const unavailable = request()
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith({}))
  })
})


afterEach(() => vi.unstubAllGlobals())

it.each([
  ['darwin', '25.0.0', true],
  ['darwin', '23.1.0', false],
  ['win32', '10.0.0', true],
  ['linux', '6.12.0', false],
] as const)('grants system audio on supported platforms: %s %s', async (platform, release, supported) => {
  vi.stubGlobal('process', { ...process, platform })
  native.release.mockReturnValue(release)
  const { game, request } = setup()
  game.pick('window:game')
  const callback = request({ audioRequested: true })
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
    video: expect.objectContaining({ id: 'window:game' }),
    ...(supported ? { audio: 'loopback' } : {}),
  }))
})

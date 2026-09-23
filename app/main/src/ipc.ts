import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TogetherFiles } from './together-files'
import { app, dialog, ipcMain, powerSaveBlocker, screen, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERO_FILE_SUFFIX } from '@shared/tracking'
import { AUDIO_EXTENSIONS, isMediaPath, VIDEO_EXTENSIONS, type IpcChannel, type IpcContract, type IpcEvent, type IpcEvents, type ScriptFile } from '@shared/ipc'
import { BrowserTabs } from './browser'
import { syncLanguage, t } from './i18n'
import type { Library } from './library'
import { logEvent } from './log'
import { Audio } from './audio'
import { GameCapture } from './game'
import { Chaster } from './chaster'
import { Models } from './models'
import { findSubtitles, readSubtitles } from './subtitles'
import { readTags } from './tags'
import type { Account } from './account'
import type { RemoteClient } from './remote/client'
import type { RemoteServer } from './remote/server'
import type { SettingsStore } from './settings/store'
import type { Updater } from './update'
import { syncNativeTheme } from './theme'
import { isForwarded, type ForwardedChannel } from '@shared/peer'
import { sessionRun, sessionSetup } from '@shared/session-settings'

type Handler<C extends IpcChannel> = (...args: Parameters<IpcContract[C]>) => ReturnType<IpcContract[C]> | Promise<ReturnType<IpcContract[C]>>

const handlers = new Map<IpcChannel, (...args: never[]) => unknown>()

export function send<E extends IpcEvent>(win: BrowserWindow, event: E, payload: IpcEvents[E]) {
  win.webContents.send(event, payload)
}

export function registerIpc(win: BrowserWindow, store: SettingsStore, library: Library, remote: RemoteServer, client: RemoteClient, account: Account, updater: Updater, ytdlp: string | null) {
  function handle<C extends IpcChannel>(channel: C, handler: Handler<C>) {
    handlers.set(channel, handler as (...args: never[]) => unknown)
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: Parameters<IpcContract[C]>) => {
      if (client.active && isForwarded(channel)) return client.call(channel, args)
      return handler(...args)
    })
  }
  remote.setApi((channel: ForwardedChannel, args) => {
    const local = handlers.get(channel)
    if (!local) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(local(...(args as never[])))
  })

  handle('dialog:openVideo', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: t('main.dialog.media'), extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
        { name: t('main.dialog.video'), extensions: [...VIDEO_EXTENSIONS] },
        { name: t('main.dialog.audio'), extensions: [...AUDIO_EXTENSIONS] },
      ],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('dialog:openStashApp', async () => {
    const filters = process.platform === 'win32' ? [{ name: 'Stash', extensions: ['exe'] }] : []
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  const defaultPathFor = (media: string, title: string, suffix: string) => {
    if (!/^https?:\/\//i.test(media)) return `${media.replace(/\.[^./\\]+$/, '')}${suffix}`
    const safeTitle = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'script'
    return join(app.getPath('downloads'), `${safeTitle}${suffix}`)
  }

  const writeScripts = async (media: string, title: string, files: ScriptFile[]): Promise<string[] | null> => {
    const defaultPath = defaultPathFor(media, title, '.funscript')
    const result = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: t('main.dialog.funscript'), extensions: ['funscript'] }] })
    if (result.canceled || !result.filePath) return null
    const base = result.filePath.replace(/\.funscript$/i, '')
    return files.map((f) => {
      const path = `${base}${f.suffix ? `.${f.suffix}` : ''}.funscript`
      writeFileSync(path, f.json)
      return path
    })
  }
  handle('dialog:saveScripts', writeScripts)

  handle('hero:export', async (media, title, json) => {
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultPathFor(media, title, HERO_FILE_SUFFIX), filters: [{ name: t('main.dialog.heroSetup'), extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, json)
    return result.filePath
  })
  handle('hero:import', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: t('main.dialog.heroSetup'), extensions: ['json'] }] })
    const path = result.filePaths[0]
    return result.canceled || !path ? null : readFileSync(path, 'utf8')
  })
  handle('hero:sidecar', (media) => {
    if (/^https?:\/\//i.test(media)) return null
    const path = defaultPathFor(media, '', HERO_FILE_SUFFIX)
    try {
      const st = statSync(path)
      return { text: readFileSync(path, 'utf8'), stamp: `${st.size}:${Math.round(st.mtimeMs)}` }
    } catch {
      return null
    }
  })

  handle('editor:load', (key) => library.editor.load(key))
  handle('editor:files', (query) => library.editor.files(query))
  handle('editor:folders', () => library.editor.folders())
  handle('editor:save', (key, doc) => library.editor.save(key, doc))
  handle('editor:saveDraft', (key, doc) => library.editor.saveDraft(key, doc))
  handle('editor:discardDraft', (key) => library.editor.discardDraft(key))
  handle('editor:markExported', (key, doc) => library.editor.markExported(key, doc))
  handle('editor:patterns', () => library.editor.patterns())
  handle('editor:savePattern', (pattern) => library.editor.savePattern(pattern))
  handle('editor:deletePattern', (id) => library.editor.deletePattern(id))
  handle('editor:export', writeScripts)

  const setFullscreen = (on: boolean) => {
    win.setFullScreen(on)
    send(win, 'window:fullscreen', on)
    return on
  }
  const toggleFullscreen = () => setFullscreen(!win.isFullScreen())
  handle('window:fullscreen', (on) => setFullscreen(on ?? !win.isFullScreen()))
  handle('window:isFullscreen', () => win.isFullScreen())
  handle('app:reportError', (message) => logEvent({ processType: 'renderer', reason: 'error', message }))
  let displayBlock: number | null = null
  handle('window:playing', (playing) => {
    if (playing && displayBlock === null) displayBlock = powerSaveBlocker.start('prevent-display-sleep')
    if (!playing && displayBlock !== null) {
      powerSaveBlocker.stop(displayBlock)
      displayBlock = null
    }
  })
  win.on('closed', () => {
    if (displayBlock !== null) powerSaveBlocker.stop(displayBlock)
    displayBlock = null
  })
  handle('app:quit', () => app.quit())
  handle('app:version', () => app.getVersion())
  handle('update:state', () => updater.get())
  handle('update:check', () => updater.check())
  handle('update:install', () => updater.install())
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
      event.preventDefault()
      toggleFullscreen()
    }
  })

  const bundledModels = app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'models')
  const models = new Models(app.getPath('userData'), bundledModels, (p) => send(win, 'models:progress', p))
  handle('models:dir', () => models.dir)
  handle('models:status', (files) => models.status(files))
  handle('models:download', async (id, file) => {
    await models.download(id, file)
    library.wakeTagger()
  })
  handle('models:remove', (file) => models.remove(file))
  handle('models:cancel', (id) => models.cancel(id))

  const audio = new Audio(app.getPath('userData'), ytdlp)
  handle('audio:decode', (source) => audio.decode(source))
  handle('audio:window', (source, startMs, durationMs, requestId) => audio.window(source, startMs, durationMs, requestId))
  handle('audio:cancelWindow', (requestId) => audio.cancelWindow(requestId))
  handle('audio:peaks', (source) => audio.peaks(source))
  const game = new GameCapture(win)
  handle('game:sources', () => game.sources())
  handle('game:capture', (id) => game.pick(id))
  handle('game:openScreenAccess', () => game.openScreenAccess())
  handle('media:tags', (path) => readTags(path))
  handle('subtitles:find', (video) => findSubtitles(video))
  handle('subtitles:read', (path) => readSubtitles(path))
  win.on('enter-full-screen', () => send(win, 'window:fullscreen', true))
  win.on('leave-full-screen', () => send(win, 'window:fullscreen', false))
  win.on('minimize', () => send(win, 'window:shown', false))
  win.on('hide', () => send(win, 'window:shown', false))
  win.on('restore', () => send(win, 'window:shown', true))
  win.on('show', () => send(win, 'window:shown', true))

  handle('window:displayHz', () => screen.getDisplayMatching(win.getBounds()).displayFrequency || 60)
  handle('settings:get', () => store.get())
  const chaster = new Chaster((status) => send(win, 'chaster:status', status))
  chaster.apply(store.get())
  win.on('closed', () => chaster.stop())
  handle('chaster:status', () => chaster.get())
  handle('account:status', () => account.get())
  handle('account:token', () => account.sessionToken())
  handle('account:url', () => account.url)
  handle('account:login', () => account.login())
  handle('account:cancelLogin', () => account.cancelLogin())
  handle('account:logout', () => account.logout())
  handle('account:refresh', () => account.refresh(true))
  handle('account:setName', (name) => account.setName(name))
  handle('account:setAvatar', (userId, png) => account.setAvatar(userId, png))
  handle('account:friends', () => account.friends())
  handle('account:addFriend', (code) => account.addFriend(code))
  handle('account:acceptFriend', (id) => account.acceptFriend(id))
  handle('account:removeFriend', (id) => account.removeFriend(id))
  const togetherFiles = new TogetherFiles(async (name) => {
    const folder = join(app.getPath('downloads'), 'Better Player P2P')
    await mkdir(folder, { recursive: true })
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
    const stem = name.slice(0, name.lastIndexOf('.')).replace(/[<>:"|?*]/g, '_')
    let safeName = ''
    for (const char of stem) {
      if (Buffer.byteLength(safeName + char) > 160) break
      safeName += char
    }
    return join(folder, `${safeName || 'video'}-${randomUUID()}${extension}`)
  })
  win.webContents.on('render-process-gone', () => { void togetherFiles.clear() })
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) void togetherFiles.clear() })
  win.on('closed', () => { void togetherFiles.clear() })
  handle('together:allowQueue', (paths) => togetherFiles.allowQueue(paths))
  handle('together:allow', (path) => togetherFiles.allow(path))
  handle('together:sendStart', (id) => togetherFiles.sendStart(id))
  handle('together:read', (id) => togetherFiles.read(id))
  handle('together:receiveStart', (video) => togetherFiles.receiveStart(video))
  handle('together:write', (id, offset, data) => togetherFiles.write(id, offset, data))
  handle('together:complete', (id, digest) => togetherFiles.complete(id, digest))
  handle('together:cancel', (id) => togetherFiles.cancel(id))
  handle('together:clear', () => togetherFiles.clear())
  handle('account:hash', (path) => account.hash(path))
  handle('account:pathForHash', (hash) => account.pathForHash(hash))
  handle('usage:track', (feature) => account.track(feature))
  handle('admin:stats', (days) => account.adminStats(days))
  handle('settings:set', (settings) => {
    store.set(settings)
    void syncLanguage(store)
    syncNativeTheme(store, win)
    remote.apply(store.get())
    client.apply(store.get())
    library.setMatchOtherFolders(store.get().library.matchOtherFolders)
    library.setAutoTag(store.get().library.autoTag)
    library.setTagServers(store.get().library.tagServers)
    chaster.apply(store.get())
    account.apply(store.get())
  })
  handle('video:get', (path) => account.mergeVideo(path, library.videoSettings(path)))
  handle('video:set', (path, settings) => {
    library.setVideoSettings(path, settings)
    account.onVideoSet(path, settings)
  })
  handle('generated:get', (key) => library.generated(key))
  handle('generated:put', (key, hash, scripts) => library.setGenerated(key, hash, scripts))

  library.setEmitter((event, payload) => {
    if (!win.isDestroyed() && !client.active) send(win, event, payload)
    remote.broadcast(event, payload)
  })
  client.setEmitter((event, payload) => {
    if (!win.isDestroyed()) send(win, event, payload)
  })
  handle('library:roots', () => library.roots())
  handle('library:addRoot', async () => {
    if (client.active) return []
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths.map((path) => library.addRoot(path))
  })
  handle('library:addPaths', (paths) => (client.active ? { play: paths.find(isMediaPath) ?? null, ask: null } : library.addPaths(paths)))
  handle('library:addServer', (input) => library.addServer(input))
  handle('library:removeRoot', (id) => (client.active ? undefined : library.removeRoot(id)))
  handle('library:remote', (path) => library.remote(path))
  handle('library:setRootSessions', (id, sessions) => library.setRootSessions(id, sessions))
  handle('library:scan', (rootId) => library.scan(rootId))
  handle('library:retag', () => library.retagAll())
  handle('library:query', async (query) => {
    await library.prepareSearch(query)
    return library.query(query)
  })
  handle('library:queryIds', async (query) => {
    await library.prepareSearch(query)
    return library.queryIds(query)
  })
  handle('library:jump', async (query, prefix) => {
    await library.prepareSearch(query)
    return library.jump(query, prefix)
  })
  handle('library:media', (id) => library.media(id))
  handle('library:scriptFolders', (path) => library.scriptFolders(path))
  handle('library:byPath', (path) => library.byPath(path))
  handle('library:byTitle', (title) => library.byTitle(title))
  handle('library:folders', () => library.folders())
  handle('library:counts', () => library.counts())
  handle('library:setRating', (id, rating) => library.setRating(id, rating))
  handle('library:setTags', (id, tags) => library.setTags(id, tags))
  handle('library:setTitle', (id, title) => library.setTitle(id, title))
  handle('library:setPinned', (ids, pinned) => library.setPinned(ids, pinned))
  handle('library:setHidden', (ids, hidden) => library.setHidden(ids, hidden))
  handle('library:setFavourite', (ids, favourite) => library.setFavourite(ids, favourite))
  handle('library:moveToFolder', (ids, folder) => library.moveToFolder(ids, folder))
  handle('library:excludeFolder', (folder) => library.excludeFolder(folder))
  handle('library:includeFolder', (folder) => library.includeFolder(folder))
  handle('library:tags', () => library.tags())
  handle('library:folderMedia', (folder) => library.folderMedia(folder))
  handle('library:addTag', (mediaIds, tag) => library.addTag(mediaIds, tag))
  handle('library:renameTag', (from, to) => library.renameTag(from, to))
  handle('library:deleteTag', (name) => library.deleteTag(name))
  handle('library:played', (path) => library.played(path))
  handle('library:playlists', () => library.playlists())
  handle('library:importStashGroups', (rootId) => library.importStashGroups(rootId))
  handle('library:createPlaylist', (name) => library.createPlaylist(name))
  handle('library:renamePlaylist', (id, name) => library.renamePlaylist(id, name))
  handle('library:deletePlaylist', (id) => library.deletePlaylist(id))
  handle('library:addToPlaylist', (id, mediaIds) => library.addToPlaylist(id, mediaIds))
  handle('library:removeFromPlaylist', (id, mediaIds) => library.removeFromPlaylist(id, mediaIds))
  handle('library:movePlaylistItems', (id, move) => library.movePlaylistItems(id, move))
  handle('library:progress', () => library.progress())
  handle('matcher:scan', () => library.matcherScan())
  handle('matcher:resolve', (set, mediaId) => library.matcherResolve(set, mediaId))
  handle('session:start', (value, name) => {
    const run = sessionRun(value, t)
    if (!run) throw new Error(t('session.error.invalid'))
    return library.startSession(run, typeof name === 'string' ? name.trim().slice(0, 120) || 'Session' : 'Session')
  })
  handle('session:played', (sessionId, mediaId, startMs, endMs) => library.sessionPlayed(sessionId, mediaId, startMs, endMs))
  handle('session:recentMediaIds', (sessions) => library.recentSessionMediaIds(sessions))
  handle('session:finish', (id, completed) => library.finishSession(id, completed))
  handle('session:saved', () => library.savedSessions())
  handle('session:history', () => library.sessionHistory())
  handle('session:save', (name, setup, favourite) => library.saveSession(name, sessionSetup(setup, t), favourite))
  handle('session:load', (kind, id) => {
    const item = kind === 'saved' ? library.savedSessions().find(s => s.id === id) : library.sessionHistory().find(s => s.id === id)
    const setup = item && ('setup' in item ? item.setup : item.run?.setup)
    if (!item || !setup) throw new Error(t('session.error.unavailable'))
    return { name: item.name, setup }
  })
  handle('session:replay', (id) => {
    const run = library.sessionHistory().find(s => s.id === id)?.run
    if (!run) throw new Error(t('session.error.unavailable'))
    const missing = new Set<number>()
    for (const clip of run.clips) {
      const row = library.media(clip.mediaId)
      if (!row || row.durationMs < clip.endMs) { missing.add(clip.mediaId); continue }
      if (!/^[a-z]+:\/\//i.test(row.path)) {
        try { if (!statSync(row.path).isFile()) missing.add(clip.mediaId) } catch { missing.add(clip.mediaId) }
      }
    }
    if (missing.size) throw new Error(t('session.error.unavailableVideos', { count: missing.size }))
    return run
  })
  handle('session:favourite', (kind, id, favourite) => library.favouriteSession(kind, id, favourite))
  handle('session:deleteSaved', (id) => library.deleteSavedSession(id))

  const browser = new BrowserTabs(win, join(__dirname, '../preload/browser.js'), (event, payload) => {
    if (!win.isDestroyed()) send(win, event, payload)
  }, ipcMain, () => account.get().me?.premium === true, toggleFullscreen)
  win.on('closed', () => browser.destroy())
  account.setEmitter((status) => {
    if (!win.isDestroyed()) send(win, 'account:status', status)
    browser.accountChanged()
  })
  handle('browser:tabs', () => browser.tabs())
  handle('browser:preview', () => browser.preview())
  handle('browser:startData', () => browser.startData())
  handle('browser:reorder', (id, toIndex) => browser.reorder(id, toIndex))
  handle('browser:toggleBookmark', (url, title) => browser.toggleBookmark(url, title))
  handle('browser:setAdBlockEnabled', (enabled) => browser.setAdBlockEnabled(enabled))
  handle('browser:open', (url) => browser.open(url))
  handle('browser:close', (id) => browser.close(id))
  handle('browser:activate', (id) => browser.activate(id))
  handle('browser:navigate', (id, url) => browser.navigate(id, url))
  handle('browser:back', (id) => browser.back(id))
  handle('browser:forward', (id) => browser.forward(id))
  handle('browser:reload', (id) => browser.reload(id))
  handle('browser:stop', (id) => browser.stop(id))
  handle('browser:bounds', (rect) => browser.setBounds(rect))
  handle('browser:capture', (id, on) => browser.capture(id, on))
  handle('browser:setRegion', (id, region) => browser.setRegion(id, region))
  handle('browser:setZone', (id, zone) => browser.setZone(id, zone))
  handle('browser:snapshot', (id, width) => browser.snapshot(id, width))
  handle('browser:pause', (id) => browser.pause(id))
  handle('browser:handoff', (id) => browser.handoff(id))
  handle('browser:play', (id) => browser.play(id))
  handle('browser:setMuted', (id, muted) => browser.setMuted(id, muted))

  remote.setEmitter((status) => {
    if (!win.isDestroyed()) send(win, 'remote:status', status)
  })
  handle('remote:status', () => remote.status())
  handle('remote:publish', (state) => remote.publish(state))
  handle('remote:source', () => client.status())
  handle('remote:playing', () => client.playing)
  handle('player:control', (command) => send(win, 'player:control', command))
  handle('remote:scripts', (url) => client.scripts(url))
}

import { ControlHandover, type Handover } from './together-handover'
import { create } from 'zustand'
import { parseGroupMsg, WATCH_GROUP_LIMIT, type GroupMsg, type SharedVideo, type WatchMember } from '@shared/together'
import { FileTransfers, type FileTransfer } from './together-transfer'
import type { AxisId } from '@shared/axes'
import {
  WATCH_DRIFT_MS,
  WATCH_TICK_MS,
  friendLabel,
  parsePeerMsg,
  reconcile,
  type ControlCmd,
  type ControlCommand,
  type ControlState,
  type Friend,
  type PeerKind,
  type PeerMsg,
  type SignalData,
  type SignalIn,
  type SignalOut,
  type WatchMsg,
} from '@shared/account'
import { defaultAxisSettings } from '@shared/settings'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { useAccount } from './account'
import { t } from './i18n'
import * as live from './live'
import { usePlayer } from './player'
import { useSettings } from './settings'

export type SessionStatus = 'inviting' | 'incoming' | 'connecting' | 'connected' | 'ended'

export interface Session {
  kind: PeerKind
  id?: string
  members: WatchMember[]
  peer: Friend
  role: 'host' | 'guest'
  status: SessionStatus
  note: string | null
  remote: ControlState | null
  peerMissing: boolean
  missing: boolean
}

interface TogetherState {
  connected: boolean
  invitePicker: boolean
  online: string[]
  session: Session | null
  hash: string | null
  handover: Handover | null
  giveControl: (id: string) => void
  answerControl: (accepted: boolean) => void
  releaseControl: () => void
  downloadsAllowed: boolean
  acceptsDownloads: boolean
  acceptDownloads: (accepted: boolean) => void
  sharedQueue: SharedVideo[]
  sharedVideo: SharedVideo | null
  sharingBusy: boolean
  transferError: string | null
  transfers: FileTransfer[]
  inviteWithControl: (friend: Friend) => void
  inviteMany: (friends: Friend[]) => void
  allowDownloads: (allowed: boolean) => void
  download: () => void
  cancelTransfer: (peerId: string) => void
  invite: (friend: Friend, kind: PeerKind) => void
  accept: () => void
  decline: () => void
  end: () => void
  command: (cmd: ControlCommand) => void
}

const CONTROL_STATE_MS = 250
const CONNECT_TIMEOUT_MS = 30_000
const RECONNECT_MIN_MS = 5000
const RECONNECT_MAX_MS = 60_000
const SEEK_JUMP_MS = 1000

const wsUrl = (base: string) => `${base.replace(/^http/, 'ws')}/ws`

export const useTogether = create<TogetherState>()((set, get) => {
  let ws: WebSocket | null = null
  let reconnectTimer = 0
  let reconnectMs = RECONNECT_MIN_MS
  let wanted = false
  let accountUrl = ''
  let stun: string[] = []
  interface Link {
    friend: Friend
    status: WatchMember['status']
    pc: RTCPeerConnection | null
    channel: RTCDataChannel | null
    queue: Promise<void>
    candidates: RTCIceCandidateInit[]
    timer: number
    grace: number
    missing: boolean
    note: string | null
  }
  const links = new Map<string, Link>()
  let pendingControl: string | null = null
  let sharingRevision = 0
  let queueTimer = 0
  let queueKey = ''
  let queueRefreshing = false
  let downloading = false
  const downloaded = new Set<string>()
  const attempted = new Set<string>()
  let latestTick: Extract<WatchMsg, { t: 'tick' }> | null = null
  let stateTimer = 0
  let tickTimer = 0
  const driven = new Set<AxisId>()
  let expectPaused: boolean | null = null
  let expectSeekMs: number | null = null
  let expectOpenHash: string | null = null
  let watchHash: string | null = null
  let applyingOpen = false
  let sessionGeneration = 0
  let openAbort: AbortController | null = null
  const reportedMissing = new Set<string>()
  let lastTimeMs = 0
  let lastWall = 0

  const sendSignal = (msg: SignalOut) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...msg, ...(get().session?.id ? { sessionId: get().session?.id } : {}) }))
  }
  const sendTo = (link: Link, msg: PeerMsg | GroupMsg) => {
    if (link.channel?.readyState !== 'open') return
    try { link.channel.send(JSON.stringify(msg)) } catch { finishLink(link, t('together.note.connectionLost')) }
  }
  const sendPeer = (msg: PeerMsg | GroupMsg) => { for (const link of links.values()) sendTo(link, msg) }
  const patch = (p: Partial<Session>) => {
    const s = get().session
    if (s) set({ session: { ...s, ...p } })
  }
  const liveSession = () => {
    const s = get().session
    return s && s.status !== 'ended' ? s : null
  }
  const publishMembers = () => {
    const s = get().session
    if (!s || s.role !== 'host') return
    const members = [...links.values()].map(({ friend, status, missing, note }) => ({ friend, status, missing, note }))
    patch({ members, peerMissing: members.some(member => member.missing) })
    if (s.kind !== 'watch') return
    const me = useAccount.getState().status.me
    const host: WatchMember = { friend: { id: me?.id ?? 'host', name: me?.name ?? '', code: me?.friendCode ?? '' }, status: 'connected', missing: false, note: null }
    sendPeer({ t: 'members', members: [host, ...members] })
  }
  const handover = new ControlHandover({
    connected: id => links.get(id)?.status === 'connected',
    role: () => get().session?.role,
    send: (id, msg) => { const link = links.get(id); if (link) sendTo(link, msg) },
    changed: handover => set({ handover }),
    read: () => controlState(),
    apply: command => {
      const p = usePlayer.getState()
      switch (command.cmd) {
        case 'intensity': p.adjustAmplitude(command.delta); break
        case 'intensityReset': p.resetAmplitude(); break
        case 'rate': p.setRate(command.rate); sendPeer(watchTick()); break
        case 'live':
          if (command.value === null) driven.delete(command.axis)
          else driven.add(command.axis)
          engine.setLive(command.axis, command.value === null ? null : Math.max(0, Math.min(1, command.value)))
          break
      }
    },
    release: () => { for (const id of driven) engine.setLive(id, null); driven.clear() },
  })
  const predownload = async () => {
    const s = get().session
    if (downloading || s?.role !== 'guest' || s.status !== 'connected' || !get().acceptsDownloads || !get().downloadsAllowed) return
    if (get().transfers.some(transfer => !['complete', 'failed'].includes(transfer.status))) return
    const video = get().sharedQueue.find(video => !downloaded.has(video.hash) && !attempted.has(video.id))
    if (!video) return
    downloading = true
    attempted.add(video.id)
    const generation = sessionGeneration
    try {
      const local = await invoke('account:pathForHash', video.hash).catch(() => null)
      if (generation !== sessionGeneration || !get().acceptsDownloads || !get().downloadsAllowed || !get().sharedQueue.some(item => item.id === video.id)) return
      if (local) downloaded.add(video.hash)
      else await files.download(s.peer.id, video)
    } finally {
      downloading = false
      window.setTimeout(() => void predownload(), 0)
    }
  }
  const refreshQueue = async () => {
    if (queueRefreshing || !get().downloadsAllowed || get().session?.role !== 'host') return
    const revision = sharingRevision
    const player = usePlayer.getState()
    const { useSession } = await import('./session').catch(() => ({ useSession: null }))
    const session = useSession?.getState()
    const ids = session?.stage === 'running' ? [] : player.playlist?.ids.slice(player.playlist.index + 1, player.playlist.index + 32) ?? []
    const planned = session?.stage === 'running' ? session.plan.slice(session.index + 1, session.index + 32).map(clip => clip.row.path) : []
    const key = JSON.stringify([player.path, ids, planned])
    if (key === queueKey || revision !== sharingRevision) return
    queueKey = key
    queueRefreshing = true
    set({ sharingBusy: true })
    try {
      const rows = await Promise.all(ids.map(id => invoke('library:media', id)))
      if (revision !== sharingRevision || key !== queueKey) return
      const paths = [...new Set([player.path, ...planned, ...rows.map(row => row?.path)].filter((path): path is string => Boolean(path)))].slice(0, 32)
      const videos = await invoke('together:allowQueue', paths)
      if (revision !== sharingRevision || key !== queueKey) return
      set({ sharedQueue: videos, sharedVideo: videos.find(video => video.hash === get().hash) ?? null, sharingBusy: false })
      for (const transfer of get().transfers) if (!videos.some(video => video.id === transfer.video.id)) files.cancel(transfer.peerId)
      sendPeer({ t: 'sharing-queue', enabled: true, videos })
    } catch {
      if (revision === sharingRevision) { queueKey = ''; set({ sharingBusy: false, transferError: t('together.transfer.unavailable') }) }
    } finally { queueRefreshing = false }
  }
  const files = new FileTransfers({
    changed: (transfers) => { set({ transfers, ...(transfers.some(transfer => transfer.direction === 'receive' && transfer.status === 'failed') ? { transferError: t('together.transfer.failed') } : {}) }); window.setTimeout(() => void predownload(), 0) },
    send: (id, msg) => { const link = links.get(id); if (link) sendTo(link, msg) },
    allowed: (id, video) => get().session?.status === 'connected' && links.get(id)?.status === 'connected' && get().downloadsAllowed && (get().session?.role === 'host' || get().acceptsDownloads) && get().sharedQueue.some(item => item.id === video.id),
    received: async (path, video) => {
      const generation = sessionGeneration
      await invoke('account:hash', path)
      if (generation !== sessionGeneration || !get().acceptsDownloads || !get().downloadsAllowed || !get().sharedQueue.some(item => item.id === video.id)) return
      downloaded.add(video.hash)
      reportedMissing.delete(video.hash)
      if (latestTick?.hash === video.hash) void applyOpen(video.hash, latestTick.positionMs, latestTick.paused, true)
    },
  })
  const closeLink = (link: Link) => {
    handover.disconnect(link.friend.id)
    if (pendingControl === link.friend.id) pendingControl = null
    window.clearTimeout(link.timer)
    window.clearTimeout(link.grace)
    files.cancel(link.friend.id)
    const channel = link.channel
    const peer = link.pc
    link.channel = null
    link.pc = null
    link.candidates = []
    channel?.close()
    peer?.close()
  }
  const revokeSharing = () => {
    sharingRevision++
    window.clearInterval(queueTimer)
    queueTimer = 0
    queueKey = ''
    attempted.clear()
    downloaded.clear()
    files.clear()
    set({ sharedVideo: null, sharedQueue: [], downloadsAllowed: false, sharingBusy: false, transferError: null })
    void invoke('together:allow', null).catch(() => undefined)
    if (get().session?.role === 'host') sendPeer({ t: 'sharing-queue', enabled: false, videos: [] })
  }
  const teardown = () => {
    sessionGeneration++
    pendingControl = null
    handover.end()
    set({ acceptsDownloads: false })
    openAbort?.abort()
    openAbort = null
    for (const link of links.values()) closeLink(link)
    links.clear()
    revokeSharing()
    void invoke('together:clear').catch(() => undefined)
    window.clearInterval(stateTimer)
    window.clearInterval(tickTimer)
    stateTimer = 0
    tickTimer = 0
    for (const id of driven) engine.setLive(id, null)
    driven.clear()
    reportedMissing.clear()
    expectPaused = null
    expectSeekMs = null
    expectOpenHash = null
    watchHash = null
    latestTick = null
    applyingOpen = false
  }
  const finish = (note: string | null) => {
    teardown()
    patch({ status: 'ended', note })
  }
  const finishLink = (link: Link, note: string | null) => {
    if (links.get(link.friend.id) !== link || link.status === 'ended') return
    link.status = 'ended'
    link.note = note
    closeLink(link)
    const s = get().session
    if (s?.role === 'guest' || s?.kind === 'control' || links.size === 1) finish(note)
    else publishMembers()
  }
  const newLink = (friend: Friend, status: Link['status']): Link => {
    const link: Link = { friend, status, pc: null, channel: null, queue: Promise.resolve(), candidates: [], timer: 0, grace: 0, missing: false, note: null }
    links.set(friend.id, link)
    return link
  }
  const failConnect = (link: Link) => {
    if (links.get(link.friend.id) !== link || link.status !== 'connecting') return
    sendSignal({ t: 'end', to: link.friend.id })
    finishLink(link, t('together.note.couldNotConnect'))
  }
  const startConnecting = (link: Link) => {
    link.status = 'connecting'
    if (get().session?.status !== 'connected') patch({ status: 'connecting' })
    window.clearTimeout(link.timer)
    link.timer = window.setTimeout(() => failConnect(link), CONNECT_TIMEOUT_MS)
    publishMembers()
  }
  const current = (link: Link, peer: RTCPeerConnection) => links.get(link.friend.id) === link && link.pc === peer
  const openPeer = (link: Link): RTCPeerConnection => {
    const servers = stun.length ? stun : useAccount.getState().status.stun
    const peer = new RTCPeerConnection({ iceServers: servers.map(urls => ({ urls })) })
    link.pc = peer
    peer.onicecandidate = (event) => {
      if (!current(link, peer) || !event.candidate) return
      const c = event.candidate
      sendSignal({ t: 'signal', to: link.friend.id, data: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } } })
    }
    peer.onconnectionstatechange = () => {
      if (!current(link, peer)) return
      window.clearTimeout(link.grace)
      const lost = () => {
        if (!current(link, peer)) return
        if (link.status === 'connecting') failConnect(link)
        else finishLink(link, t('together.note.connectionLost'))
      }
      if (peer.connectionState === 'failed') lost()
      else if (peer.connectionState === 'disconnected') { handover.disconnect(link.friend.id); link.grace = window.setTimeout(lost, 10_000) }
    }
    peer.ondatachannel = (event) => {
      if (!current(link, peer)) { event.channel.close(); return }
      if (event.channel.label?.startsWith('bp-file:')) {
        if (get().session?.role === 'guest' && get().session?.kind === 'watch') files.attach(link.friend.id, event.channel)
        else event.channel.close()
      } else if (get().session?.role === 'guest' && !link.channel) attach(link, event.channel)
      else event.channel.close()
    }
    return peer
  }
  const attach = (link: Link, channel: RTCDataChannel) => {
    link.channel = channel
    channel.onopen = () => {
      if (links.get(link.friend.id) !== link || link.channel !== channel) return
      window.clearTimeout(link.timer)
      link.status = 'connected'
      patch({ status: 'connected' })
      startSession(link)
      publishMembers()
    }
    channel.onclose = () => {
      if (link.channel === channel && link.status === 'connected') finishLink(link, t('together.note.ended'))
    }
    channel.onmessage = (event) => {
      if (link.channel !== channel || link.status !== 'connected' || typeof event.data !== 'string' || event.data.length > 32_000) return
      let raw: unknown
      try { raw = JSON.parse(event.data) } catch { return }
      const group = parseGroupMsg(raw)
      if (group) { onGroup(link, group); return }
      const msg = parsePeerMsg(raw)
      if (msg) onPeer(msg, link)
    }
  }
  const offer = async (link: Link) => {
    const peer = openPeer(link)
    attach(link, peer.createDataChannel('bp', { ordered: true }))
    const desc = await peer.createOffer()
    if (!current(link, peer)) return
    await peer.setLocalDescription(desc)
    if (current(link, peer) && desc.sdp) sendSignal({ t: 'signal', to: link.friend.id, data: { type: 'offer', sdp: desc.sdp } })
  }
  const flushCandidates = async (link: Link, peer: RTCPeerConnection) => {
    const candidates = link.candidates
    link.candidates = []
    for (const candidate of candidates) {
      if (!current(link, peer)) return
      await peer.addIceCandidate(candidate).catch(() => undefined)
    }
  }
  const onSignal = async (link: Link, data: SignalData) => {
    const s = get().session
    if (!s || links.get(link.friend.id) !== link || !['connecting', 'connected'].includes(link.status)) return
    if ('candidate' in data) {
      if (link.pc?.remoteDescription) await link.pc.addIceCandidate(data.candidate).catch(() => undefined)
      else if (link.candidates.length < 128) link.candidates.push(data.candidate)
      return
    }
    if (data.type === 'offer') {
      if (s.role !== 'guest' || link.pc) return
      const peer = openPeer(link)
      await peer.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      if (!current(link, peer)) return
      await flushCandidates(link, peer)
      if (!current(link, peer)) return
      const answer = await peer.createAnswer()
      if (!current(link, peer)) return
      await peer.setLocalDescription(answer)
      if (current(link, peer) && answer.sdp) sendSignal({ t: 'signal', to: link.friend.id, data: { type: 'answer', sdp: answer.sdp } })
    } else if (link.pc && s.role === 'host' && !link.pc.remoteDescription) {
      const peer = link.pc
      await peer.setRemoteDescription({ type: 'answer', sdp: data.sdp })
      if (current(link, peer)) await flushCandidates(link, peer)
    }
  }
  const onGroup = (link: Link, msg: GroupMsg) => {
    const s = get().session
    if (s?.kind !== 'watch') return
    switch (msg.t) {
      case 'control-offer': case 'control-end': case 'control-answer': case 'control-state': case 'control-command': case 'control-heartbeat':
        handover.receive(link.friend, msg)
        return
      case 'sharing-queue':
        if (s.role !== 'guest') return
        for (const transfer of get().transfers) if (!msg.enabled || !msg.videos.some(video => video.id === transfer.video.id)) files.cancel(transfer.peerId)
        set({ downloadsAllowed: msg.enabled, sharedQueue: msg.enabled ? msg.videos : [], sharedVideo: msg.videos.find(video => video.hash === watchHash) ?? null, transferError: msg.enabled ? get().transferError : null })
        void predownload()
        return
      case 'members':
        if (s.role === 'guest') patch({ members: msg.members })
        return
      case 'sharing':
        if (s.role !== 'guest') return
        if (get().sharedVideo?.id !== msg.video?.id) files.cancel(link.friend.id)
        set({ sharedVideo: msg.video, sharedQueue: msg.video ? [msg.video] : [], downloadsAllowed: msg.video !== null, transferError: null })
        void predownload()
        return
      case 'file-request':
        if (s.role === 'host' && link.pc && get().downloadsAllowed) {
          const video = get().sharedQueue.find(video => video.id === msg.offerId)
          if (video) void files.send(link.friend.id, msg.requestId, video, link.pc)
        }
        return
      case 'file-cancel': return files.cancel(link.friend.id, msg.requestId)
      case 'ready':
        if (s.role === 'host' && msg.hash === get().hash) { link.missing = false; publishMembers() }
        return
    }
  }

  const startSession = (link: Link) => {
    const s = get().session
    if (!s) return
    if (s.kind === 'control' && s.role === 'host' && !stateTimer) {
      stateTimer = window.setInterval(() => sendPeer(controlState()), CONTROL_STATE_MS)
    }
    if (s.kind === 'watch' && s.role === 'host') {
      sendTo(link, watchOpen())
      sendTo(link, { t: 'sharing-queue', enabled: get().downloadsAllowed, videos: get().sharedQueue })
      if (!tickTimer) tickTimer = window.setInterval(() => sendPeer(watchTick()), WATCH_TICK_MS)
      if (pendingControl === link.friend.id) { pendingControl = null; handover.offer(link.friend) }
    }
  }

  const controlState = (): ControlState => {
    const p = usePlayer.getState()
    const l = live.get()
    const scripted = live.axisIdsWith(live.FLAG_SCRIPT) as AxisId[]
    const defaults = useSettings.getState().settings?.axesDefault
    const amps = scripted.map((id) => (p.video.axes[id] ?? defaults?.[id] ?? defaultAxisSettings(id)).amplitude)
    return {
      t: 'state',
      media: p.path !== null,
      paused: p.snapshot.paused,
      positionMs: l.timeMs,
      durationMs: p.snapshot.durationMs,
      rate: p.snapshot.rate,
      intensity: amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : null,
      stroke: live.axisValue('L0'),
    }
  }
  const watchOpen = (): WatchMsg => ({ t: 'open', hash: get().hash, positionMs: live.get().timeMs, paused: usePlayer.getState().snapshot.paused, rate: usePlayer.getState().snapshot.rate })
  const watchTick = (): WatchMsg => ({ t: 'tick', hash: get().hash, positionMs: live.get().timeMs, paused: usePlayer.getState().snapshot.paused, rate: usePlayer.getState().snapshot.rate })
  const watchMediaReady = () => {
    const s = get().session
    return s?.kind === 'watch' && !applyingOpen &&
      (s.role === 'host' || (!s.missing && watchHash !== null && watchHash === get().hash))
  }

  const applyPlayPause = (paused: boolean, positionMs: number, quiet: boolean) => {
    const p = usePlayer.getState()
    if (!p.path || !p.snapshot.loaded) return
    if (quiet && p.snapshot.paused !== paused) expectPaused = paused
    if (Math.abs(live.get().timeMs - positionMs) > WATCH_DRIFT_MS) {
      if (quiet) expectSeekMs = positionMs
      p.seek(positionMs / 1000)
    }
    if (paused && !p.snapshot.paused) p.pause()
    else if (!paused && p.snapshot.paused) p.play()
  }
  const applySeek = (positionMs: number, quiet: boolean) => {
    const p = usePlayer.getState()
    if (!p.path || !p.snapshot.loaded) return
    if (quiet) expectSeekMs = positionMs
    p.seek(positionMs / 1000)
  }
  const applyOpen = async (hash: string | null, positionMs: number, paused: boolean, quiet: boolean) => {
    const generation = sessionGeneration
    const p = usePlayer.getState()
    if (hash === null) {
      patch({ missing: false })
      if (p.path) applyPlayPause(true, live.get().timeMs, quiet)
      return
    }
    if (applyingOpen) return
    if (hash === get().hash && p.path) {
      patch({ missing: false })
      if (quiet && latestTick?.hash === hash && latestTick.rate !== undefined) p.setRate(latestTick.rate)
      applyPlayPause(paused, positionMs, quiet)
      if (quiet && get().session?.id) sendPeer({ t: 'ready', hash })
      return
    }
    if (reportedMissing.has(hash)) {
      patch({ missing: true })
      return
    }
    applyingOpen = true
    const controller = new AbortController()
    openAbort = controller
    try {
      const path = await invoke('account:pathForHash', hash).catch(() => null)
      if (generation !== sessionGeneration) return
      if (!path) {
        patch({ missing: true })
        reportedMissing.add(hash)
        sendPeer({ t: 'missing', hash })
        return
      }
      patch({ missing: false })
      if (quiet) expectOpenHash = hash
      await p.open(path, positionMs / 1000, undefined, true, controller.signal).catch(() => undefined)
      if (generation !== sessionGeneration) return
      if (usePlayer.getState().path === path) {
        set({ hash })
        if (quiet && latestTick?.hash === hash && latestTick.rate !== undefined) usePlayer.getState().setRate(latestTick.rate)
        if (paused) usePlayer.getState().pause()
        if (quiet && get().session?.id) sendPeer({ t: 'ready', hash })
      }
    } finally {
      if (generation === sessionGeneration) {
        openAbort = null
        applyingOpen = false
        window.setTimeout(() => {
          if (generation === sessionGeneration && expectOpenHash === hash) expectOpenHash = null
        }, 2000)
      }
    }
  }

  const onPeer = (msg: PeerMsg, link: Link) => {
    const s = get().session
    if (!s) return
    const p = usePlayer.getState()
    const quiet = s.role === 'guest'
    switch (msg.t) {
      case 'state':
        if (s.kind === 'control' && s.role === 'guest') patch({ remote: msg })
        return
      case 'cmd':
        if (s.kind !== 'control' || s.role !== 'host') return
        switch (msg.cmd) {
          case 'play':
            return p.play()
          case 'pause':
            return p.pause()
          case 'seek':
            return p.seek(msg.ms / 1000)
          case 'seekBy':
            return p.seekBy(msg.s)
          case 'intensity':
            return p.adjustAmplitude(msg.delta)
          case 'intensityReset':
            return p.resetAmplitude()
          case 'rate':
            return p.setRate(msg.rate)
          case 'live':
            if (msg.value === null) driven.delete(msg.axis)
            else driven.add(msg.axis)
            return engine.setLive(msg.axis, msg.value === null ? null : Math.max(0, Math.min(1, msg.value)))
        }
        return
      case 'open':
        if (s.kind === 'watch') {
          if (!quiet && msg.hash === get().hash && link.missing) { link.missing = false; publishMembers() }
          if (quiet) { watchHash = msg.hash; latestTick = { ...msg, t: 'tick' } }
          void applyOpen(msg.hash, msg.positionMs, msg.paused, quiet)
        }
        return
      case 'play':
      case 'pause':
        if (watchMediaReady()) applyPlayPause(msg.t === 'pause', msg.positionMs, quiet)
        return
      case 'seek':
        if (watchMediaReady()) applySeek(msg.positionMs, quiet)
        return
      case 'tick': {
        if (s.kind !== 'watch' || s.role !== 'guest') return
        watchHash = msg.hash
        latestTick = msg
        if (applyingOpen) return
        if (msg.hash !== null && msg.hash === get().hash && msg.rate !== undefined && msg.rate !== p.snapshot.rate) p.setRate(msg.rate)
        if (msg.hash === null || msg.hash === get().hash) patch({ missing: false })
        const fix = reconcile({ hash: get().hash, positionMs: live.get().timeMs, paused: p.snapshot.paused }, msg)
        if (!fix) return
        if (fix.do === 'open') void applyOpen(fix.hash, fix.positionMs, fix.paused, true)
        else if (fix.do === 'seek') applySeek(fix.positionMs, true)
        else applyPlayPause(fix.do === 'pause', fix.positionMs, true)
        return
      }
      case 'missing':
        if (s.kind === 'watch') { link.missing = msg.hash === get().hash; publishMembers() }
        return
    }
  }

  usePlayer.subscribe((state, prev) => {
    if (state.path !== prev.path) {
      if (get().session?.role === 'host' && get().downloadsAllowed) void refreshQueue()
      lastWall = 0
      set({ hash: null })
      if (!state.path) {
        const s = liveSession()
        if (s?.kind === 'watch' && s.status === 'connected') sendPeer(watchOpen())
        return
      }
      const path = state.path
      void invoke('account:hash', path)
        .catch(() => null)
        .then((hash) => {
          if (usePlayer.getState().path !== path) return
          set({ hash })
          const s = liveSession()
          if (s?.kind !== 'watch') return
          patch({ peerMissing: false, missing: false })
          if (s.role === 'host') { for (const link of links.values()) link.missing = false; publishMembers() }
          if (hash !== null && hash === expectOpenHash) {
            expectOpenHash = null
            return
          }
          if (s.status === 'connected') sendPeer(watchOpen())
        })
      return
    }
    const s = liveSession()
    if (s?.kind !== 'watch' || s.status !== 'connected' || !state.path) return
    if (s.role === 'guest' && !watchMediaReady()) return
    if (state.snapshot.paused !== prev.snapshot.paused) {
      if (applyingOpen) return
      if (expectPaused === state.snapshot.paused) {
        expectPaused = null
        return
      }
      sendPeer({ t: state.snapshot.paused ? 'pause' : 'play', positionMs: live.get().timeMs })
    }
  })
  live.subscribe((l) => {
    const now = Date.now()
    const s = liveSession()
    if (s?.kind === 'watch' && s.status === 'connected' && lastWall > 0 && (s.role === 'host' || watchMediaReady())) {
      const p = usePlayer.getState()
      const expected = lastTimeMs + (p.snapshot.paused ? 0 : (now - lastWall) * p.snapshot.rate)
      if (p.snapshot.loaded && Math.abs(l.timeMs - expected) > SEEK_JUMP_MS) {
        if (expectSeekMs !== null && Math.abs(l.timeMs - expectSeekMs) < WATCH_DRIFT_MS) expectSeekMs = null
        else sendPeer({ t: 'seek', positionMs: l.timeMs })
      }
    }
    lastTimeMs = l.timeMs
    lastWall = now
  })

  const onMessage = (msg: SignalIn) => {
    const s = get().session
    if (('from' in msg && msg.t !== 'invite' || msg.t === 'error') && s?.id !== msg.sessionId) return
    const link = 'from' in msg ? links.get(msg.from) : undefined
    switch (msg.t) {
      case 'hello':
        stun = msg.stun
        reconnectMs = RECONNECT_MIN_MS
        return set({ connected: true, online: msg.online })
      case 'presence':
        if (!msg.online) { const offline = links.get(msg.id); if (offline) finishLink(offline, t('together.note.offline', { name: friendLabel(offline.friend) })) }
        return set({ online: msg.online ? [...new Set([...get().online, msg.id])] : get().online.filter(id => id !== msg.id) })
      case 'friends': return void invoke('account:friends').catch(() => undefined)
      case 'invite': {
        const friend = useAccount.getState().status.friends.friends.find(f => f.id === msg.from)
        if (!friend || liveSession()) {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'decline', to: msg.from, sessionId: msg.sessionId }))
          return
        }
        teardown()
        newLink(friend, 'inviting')
        return set({ session: { kind: msg.kind, id: msg.sessionId, members: [], peer: friend, role: 'guest', status: 'incoming', note: null, remote: null, peerMissing: false, missing: false } })
      }
      case 'accept':
        if (link?.status === 'inviting' && s?.role === 'host' && s.kind === msg.kind) {
          startConnecting(link)
          void offer(link).catch(() => failConnect(link))
        }
        return
      case 'decline':
        if (link?.status === 'inviting') finishLink(link, t('together.note.declined', { name: friendLabel(link.friend) }))
        return
      case 'signal':
        if (link) link.queue = link.queue.then(() => onSignal(link, msg.data)).catch(() => failConnect(link))
        return
      case 'end':
        if (link) finishLink(link, t('together.note.peerEnded', { name: friendLabel(link.friend) }))
        return
      case 'error': {
        const target = msg.to ? links.get(msg.to) : undefined
        if (target?.status === 'inviting') finishLink(target, msg.code === 'premium' ? t('together.note.premiumNeeded') : msg.code === 'offline' ? t('together.note.offline', { name: friendLabel(target.friend) }) : t('together.note.couldNotInvite'))
        return
      }
    }
  }
  const connect = () => {
    const { token } = useAccount.getState()
    if (!wanted || !token || !accountUrl || ws) return
    const socket = new WebSocket(wsUrl(accountUrl))
    ws = socket
    socket.onopen = () => {
      if (ws === socket) socket.send(JSON.stringify({ t: 'auth', token } satisfies SignalOut))
    }
    socket.onmessage = (e) => {
      if (ws !== socket) return
      try {
        onMessage(JSON.parse(String(e.data)) as SignalIn)
      } catch {
      }
    }
    socket.onclose = (event) => {
      if (ws !== socket) return
      ws = null
      set({ connected: false, online: [] })
      if (liveSession()) finish(t('together.note.connectionLost'))
      if (!wanted || event?.code === 4000) return
      reconnectTimer = window.setTimeout(connect, reconnectMs + Math.random() * 1000)
      reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2)
    }
  }
  const disconnect = () => {
    wanted = false
    window.clearTimeout(reconnectTimer)
    const socket = ws
    ws = null
    if (liveSession()) finish(t('together.note.connectionLost'))
    socket?.close()
    set({ connected: false, online: [] })
  }
  useAccount.subscribe((state) => {
    const on = (state.status.state === 'in' || state.status.state === 'error') && state.token !== null
    if (on && !wanted) {
      wanted = true
      connect()
    } else if (!on && wanted) disconnect()
    const s = liveSession()
    if (s && state.status.state === 'in' && state.status.me) {
      for (const link of links.values()) {
        if (!state.status.friends.friends.some(friend => friend.id === link.friend.id)) {
          sendSignal({ t: 'end', to: link.friend.id })
          finishLink(link, t('together.note.noLongerFriends'))
        }
      }
    }
  })
  void invoke('account:url')
    .then((url) => {
      accountUrl = url
      if (wanted) connect()
    })
    .catch(() => undefined)

  const inviteOne = (friend: Friend, kind: PeerKind) => {
    let s = liveSession()
    if (!get().connected || (s && (s.kind !== 'watch' || kind !== 'watch' || s.role !== 'host'))) return
    if (!s) {
      teardown()
      s = { kind, id: kind === 'watch' ? crypto.randomUUID() : undefined, members: [], peer: friend, role: 'host', status: 'inviting', note: null, remote: null, peerMissing: false, missing: false }
      set({ session: s })
    }
    if (links.get(friend.id)?.status !== 'ended' && links.has(friend.id)) return
    for (const [id, link] of links) if (link.status === 'ended') links.delete(id)
    if (links.size >= WATCH_GROUP_LIMIT - 1) return
    const link = newLink(friend, 'inviting')
    link.timer = window.setTimeout(() => { sendSignal({ t: 'end', to: link.friend.id }); finishLink(link, t('together.note.noAnswer')) }, 60_000)
    publishMembers()
    sendSignal({ t: 'invite', to: friend.id, kind })
  }
  return {
    connected: false,
    invitePicker: false,
    online: [],
    session: null,
    hash: null,
    sharedVideo: null,
    sharingBusy: false,
    transferError: null,
    transfers: [],
    invite: inviteOne,
    inviteWithControl: friend => {
      inviteOne(friend, 'watch')
      if (get().session?.kind !== 'watch' || get().session?.role !== 'host') return
      const link = links.get(friend.id)
      if (!link || link.status === 'ended') return
      if (link.status === 'connected') { pendingControl = null; handover.offer(friend) }
      else pendingControl = friend.id
    },
    inviteMany: (friends) => { for (const friend of friends) inviteOne(friend, 'watch') },
    handover: null,
    giveControl: id => { const link = links.get(id); if (link?.status === 'connected') { pendingControl = null; handover.offer(link.friend) } },
    answerControl: accepted => handover.answer(accepted),
    releaseControl: () => handover.end(),
    downloadsAllowed: false,
    acceptsDownloads: false,
    sharedQueue: [],
    acceptDownloads: accepted => {
      if (get().session?.role !== 'guest') return
      set({ acceptsDownloads: accepted })
      if (!accepted) files.clear()
      else { attempted.clear(); void predownload() }
    },
    allowDownloads: allowed => {
      if (get().session?.kind !== 'watch' || get().session?.role !== 'host') return
      revokeSharing()
      if (!allowed) return
      set({ downloadsAllowed: true })
      sendPeer({ t: 'sharing-queue', enabled: true, videos: [] })
      void refreshQueue()
      queueTimer = window.setInterval(() => void refreshQueue(), 1000)
    },
    download: () => { attempted.clear(); set({ transferError: null }); void predownload() },
    cancelTransfer: (id) => files.cancel(id),
    accept: () => {
      const s = get().session
      const link = s ? links.get(s.peer.id) : undefined
      if (s?.status !== 'incoming' || !link) return
      startConnecting(link)
      sendSignal({ t: 'accept', to: s.peer.id, kind: s.kind })
    },
    decline: () => {
      const s = get().session
      if (s?.status !== 'incoming') return
      sendSignal({ t: 'decline', to: s.peer.id })
      teardown()
      set({ session: null })
    },
    end: () => {
      for (const link of links.values()) if (link.status !== 'ended') sendSignal({ t: 'end', to: link.friend.id })
      teardown()
      set({ session: null })
    },
    command: (cmd) => {
      handover.command(cmd)
      const s = get().session
      if (s?.kind === 'control' && s.role === 'guest' && s.status === 'connected') sendPeer({ t: 'cmd', ...cmd } satisfies ControlCmd)
    },
  }
})

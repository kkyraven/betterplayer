import type { ControlCommand, ControlState, Friend } from '@shared/account'
import type { HandoverMsg } from '@shared/together'

export interface Handover {
  id: string
  peer: Friend
  role: 'owner' | 'controller'
  status: 'offering' | 'offered' | 'active'
  remote: ControlState | null
}
interface Ports {
  connected: (id: string) => boolean
  role: () => 'host' | 'guest' | undefined
  send: (id: string, msg: HandoverMsg) => void
  changed: (handover: Handover | null) => void
  read: () => ControlState
  apply: (command: ControlCommand) => void
  release: () => void
}

export class ControlHandover {
  private grant: Handover | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastMessage = 0
  constructor(private readonly ports: Ports) {}

  private set(grant: Handover | null) { this.grant = grant; this.ports.changed(grant) }

  private start(grant: Handover) {
    this.set(grant)
    this.lastMessage = Date.now()
    this.timer = setInterval(() => {
      const current = this.grant
      if (!current) return
      if (!this.ports.connected(current.peer.id) || Date.now() - this.lastMessage > (current.status === 'active' ? 4000 : 30_000)) { this.end(); return }
      if (current.status !== 'active') return
      this.ports.send(current.peer.id, current.role === 'owner' ? { t: 'control-state', id: current.id, state: this.ports.read() } : { t: 'control-heartbeat', id: current.id })
    }, 250)
  }

  offer(peer: Friend) {
    if (this.ports.role() !== 'host' || !this.ports.connected(peer.id)) return
    this.end()
    const grant: Handover = { id: crypto.randomUUID(), peer, role: 'owner', status: 'offering', remote: null }
    this.start(grant)
    this.ports.send(peer.id, { t: 'control-offer', id: grant.id })
  }

  answer(accepted: boolean) {
    const grant = this.grant
    if (!grant || grant.status !== 'offered' || !this.ports.connected(grant.peer.id)) return
    this.ports.send(grant.peer.id, { t: 'control-answer', id: grant.id, accepted })
    if (!accepted) { this.end(false); return }
    this.lastMessage = Date.now()
    this.set({ ...grant, status: 'active' })
  }

  receive(peer: Friend, message: HandoverMsg) {
    if (!this.ports.connected(peer.id)) return
    if (message.t === 'control-offer') {
      if (this.ports.role() !== 'guest' || this.grant) return
      this.start({ id: message.id, peer, role: 'controller', status: 'offered', remote: null })
      return
    }
    const grant = this.grant
    if (!grant || grant.id !== message.id || grant.peer.id !== peer.id) return
    if (message.t === 'control-end') { this.end(false); return }
    if (message.t === 'control-answer' && grant.role === 'owner' && grant.status === 'offering') {
      if (!message.accepted) { this.end(false); return }
      this.lastMessage = Date.now()
      this.set({ ...grant, status: 'active' })
      this.ports.send(peer.id, { t: 'control-state', id: grant.id, state: this.ports.read() })
    }
    if (grant.status !== 'active') return
    if (message.t === 'control-heartbeat' && grant.role === 'owner') this.lastMessage = Date.now()
    if (message.t === 'control-state' && grant.role === 'controller') {
      this.lastMessage = Date.now()
      this.set({ ...grant, remote: message.state })
    }
    if (message.t === 'control-command' && grant.role === 'owner') this.ports.apply(message.command)
  }

  command(command: ControlCommand) {
    const grant = this.grant
    if (grant?.role === 'controller' && grant.status === 'active' && this.ports.connected(grant.peer.id)) this.ports.send(grant.peer.id, { t: 'control-command', id: grant.id, command })
  }

  disconnect(id: string) { if (this.grant?.peer.id === id) this.end() }

  end(notify = true) {
    const grant = this.grant
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.set(null)
    if (grant?.role === 'owner') this.ports.release()
    if (grant && notify) this.ports.send(grant.peer.id, { t: 'control-end', id: grant.id })
  }
}

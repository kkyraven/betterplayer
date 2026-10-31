// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { normalizeAdvancedPain, type AdvancedPain } from '@shared/dom-pain'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage, type BrowserWindow } from 'electron'
import {
  SIGNED_OUT_AL,
  defaultDomAi,
  normalizeDomAi,
  newDom,
  normalizeDom,
  type AlPersona,
  type ChatMessage,
  type ChatReply,
  type ChatTool,
  type DomAccount,
  type DomAiSettings,
  type DomMemory,
  type DomMemoryKind,
  type DomPose,
  type DomProfile,
  type DomYou,
  normalizeYou,
  normalizePleasurePain,
  type PleasurePain,
} from '@shared/dom'
import { AgenticLover, domError, replyOf } from './agentic'
import { fromAl, toAl } from './memories'
import { comfyFiles, comfyImage } from './comfy'
import { DomDb } from './store'

const withBoundaries = (persona: string, boundaries: string[]) => (boundaries.length ? `${persona.trim()}\n\nNever: ${boundaries.join('; ')}.` : persona)
const pulledKey = (domId: string) => `memoriesPulled:${domId}`

export class Dom {
  private readonly db: DomDb
  readonly al: AgenticLover

  constructor(dataDir: string) {
    this.db = new DomDb(join(dataDir, 'dom.sqlite'))
    this.al = new AgenticLover(this.db)
  }

  close() {
    this.db.close()
  }

  list(): DomProfile[] {
    return this.db.doms()
  }

  save(dom: DomProfile) {
    this.db.putDom(normalizeDom({ ...dom, updatedAt: Date.now() }, dom.id, Date.now()))
  }

  remove(id: string) {
    this.db.deleteDom(id)
    this.db.setMeta(pulledKey(id), null)
  }

  private dom(id: string): DomProfile {
    const dom = this.db.doms().find((d) => d.id === id)
    if (!dom) throw new Error(`no dom ${id}`)
    return dom
  }

  async you(): Promise<DomYou> {
    const saved = this.db.meta('you')
    if (saved !== null) {
      try {
        return normalizeYou(JSON.parse(saved))
      } catch {
      }
    }
    return normalizeYou(this.al.signedIn ? await this.al.profile().catch(() => null) : null)
  }

  setYou(you: DomYou) {
    this.db.setMeta('you', JSON.stringify(normalizeYou(you)))
  }

  advancedPain(): AdvancedPain {
    try { return normalizeAdvancedPain(JSON.parse(this.db.meta('advancedPain') ?? 'null')) }
    catch { return normalizeAdvancedPain(null) }
  }

  setAdvancedPain(pain: AdvancedPain) {
    this.db.setMeta('advancedPain', JSON.stringify(normalizeAdvancedPain(pain)))
  }

  pleasurePain(): PleasurePain {
    try {
      return normalizePleasurePain(JSON.parse(this.db.meta('pleasurePain') ?? 'null'))
    } catch {
      return normalizePleasurePain(null)
    }
  }

  setPleasurePain(pp: PleasurePain) {
    this.db.setMeta('pleasurePain', JSON.stringify(normalizePleasurePain(pp)))
  }

  ai(): DomAiSettings {
    try {
      return normalizeDomAi(JSON.parse(this.db.meta('ai') ?? '{}'))
    } catch {
      return defaultDomAi()
    }
  }

  setAi(ai: DomAiSettings) {
    this.db.setMeta('ai', JSON.stringify(normalizeDomAi(ai)))
  }

  hasKey(): boolean {
    return this.db.meta('ownKey') !== null
  }

  setKey(key: string | null) {
    if (!key) return this.db.setMeta('ownKey', null)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No keychain to keep the key in')
    this.db.setMeta('ownKey', safeStorage.encryptString(key).toString('base64'))
  }

  private key(): string | null {
    const sealed = this.db.meta('ownKey')
    if (!sealed) return null
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  async account(freeMinutes: boolean): Promise<DomAccount> {
    if (!this.al.signedIn) return SIGNED_OUT_AL
    try {
      return await this.al.account(freeMinutes)
    } catch (error) {
      if (!this.al.signedIn) return SIGNED_OUT_AL
      throw error
    }
  }

  async login(email: string, password: string, freeMinutes: boolean) {
    await this.al.login(email, password)
    return this.account(freeMinutes)
  }

  async register(email: string, username: string, password: string, freeMinutes: boolean) {
    await this.al.register(email, username, password)
    return this.account(freeMinutes)
  }

  async loginWith(provider: 'google' | 'discord', win: BrowserWindow, freeMinutes: boolean) {
    await this.al.loginWith(provider, win)
    return this.account(freeMinutes)
  }

  async chat(messages: ChatMessage[], tools: ChatTool[], freeMinutes: boolean): Promise<ChatReply> {
    const ai = this.ai()
    if (ai.provider === 'agenticlover') return this.al.chat(ai.alModel, messages, tools, freeMinutes)
    const key = this.key()
    let res: Response
    try {
      res = await fetch(`${ai.ownUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: ai.ownModel, messages, tools, stream: false, temperature: 0.9, max_tokens: 800 }),
      })
    } catch (error) {
      throw domError('network', String(error))
    }
    if (!res.ok) throw domError('server', `${res.status} ${(await res.text()).slice(0, 200)}`)
    return replyOf((await res.json()) as Parameters<typeof replyOf>[0])
  }

  async ownModels(url: string): Promise<string[]> {
    try {
      const key = this.key()
      const res = await fetch(`${url.replace(/\/+$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return []
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      return (json.data ?? []).flatMap((m) => (m.id ? [m.id] : []))
    } catch {
      return []
    }
  }

  personas(source: 'mine' | 'directory', query: string): Promise<AlPersona[]> {
    return this.al.personas(source, query)
  }

  async importPersona(source: 'mine' | 'directory', id: string): Promise<DomProfile> {
    const p = await this.al.persona(source, id)
    const dom = newDom(randomUUID(), Date.now(), p.name)
    const imported: DomProfile = {
      ...dom,
      persona: withBoundaries(p.prompt || p.description, p.limits),
      portrait: await this.al.avatar(p.avatarUrl),
      images: { ...dom.images, appearance: p.imagePrompt, negative: p.imageNegative, checkpoint: p.checkpoint, loras: p.loras },
      alPersonaId: p.id,
    }
    this.db.putDom(imported)
    return imported
  }

  async refreshPersona(domId: string): Promise<DomProfile> {
    const dom = this.dom(domId)
    if (!dom.alPersonaId) return dom
    const p = await this.al.persona('mine', dom.alPersonaId)
    const next: DomProfile = { ...dom, name: p.name || dom.name, persona: p.prompt ? withBoundaries(p.prompt, p.limits) : dom.persona, updatedAt: Date.now() }
    this.db.putDom(next)
    return next
  }

  async memories(domId: string): Promise<DomMemory[]> {
    const { alPersonaId } = this.dom(domId)
    if (alPersonaId && !this.db.meta(pulledKey(domId))) await this.pull(domId, alPersonaId)
    return this.db.memories(domId)
  }

  private async pull(domId: string, alPersonaId: string) {
    const list = await this.al.memories(alPersonaId)
    const seen = this.db.alIds(domId)
    for (const m of list) {
      if (seen.has(String(m.id))) continue
      const memory = fromAl(m)
      this.db.addMemory(domId, { ...memory, id: randomUUID(), createdAt: memory.createdAt || Date.now() }, memory.id)
    }
    this.db.setMeta(pulledKey(domId), '1')
  }

  async pullMemories(domId: string): Promise<DomMemory[]> {
    const { alPersonaId } = this.dom(domId)
    if (alPersonaId) await this.pull(domId, alPersonaId)
    return this.db.memories(domId)
  }

  async pushMemories(domId: string, memoryIds: string[]): Promise<DomMemory[]> {
    const { alPersonaId } = this.dom(domId)
    if (!alPersonaId) throw new Error(`dom ${domId} is not from Agentic Lover`)
    for (const id of memoryIds) {
      const m = this.db.memories(domId).find((x) => x.id === id && !x.synced)
      if (!m) continue
      const al = toAl(m.kind, m.content)
      this.db.markSent(domId, m, String((await this.al.addMemory(alPersonaId, al.kind, al.content)).id))
    }
    return this.db.memories(domId)
  }

  remember(domId: string, kind: DomMemoryKind, content: string): DomMemory {
    const memory: DomMemory = { id: randomUUID(), kind, content, createdAt: Date.now(), synced: false }
    this.db.addMemory(domId, memory)
    return memory
  }

  forget(memoryId: string) {
    this.db.deleteMemory(memoryId)
  }

  forgetAll(domId: string) {
    this.db.clearMemories(domId)
  }

  async image(domId: string, pose: DomPose): Promise<string> {
    const { images } = this.dom(domId)
    const prompt = [images.appearance, pose.pose, pose.clothing, pose.location].map((s) => s.trim()).filter(Boolean).join(', ')
    if (images.provider === 'comfyui') return comfyImage(images.comfyUrl, images.checkpoint, prompt, images.negative, images.loras)
    if (images.provider === 'agenticlover') return this.al.image(prompt, images.negative)
    throw new Error('images are off')
  }

  comfyFiles(url: string) {
    return comfyFiles(url)
  }
}

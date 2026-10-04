// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { BrowserWindow, safeStorage } from 'electron'
import { AGENTIC_LOVER_API, DOM_ERROR_PREFIX, DOM_FREE_SECONDS, normalizeLoras, type AlModel, type DomLora, type AlPersona, type AlTier, type ChatMessage, type ChatReply, type ChatTool, type DomAccount, type DomErrorCode } from '@shared/dom'
import type { AlMemoryJson } from './memories'
import type { DomDb } from './store'

const FRONTEND = 'https://app.agenticlover.ai'
const EXPIRY_MARGIN_MS = 60_000
const TIERS: readonly AlTier[] = ['free', 'pro', 'supporter_plus', 'supporter_plus_plus']

export const domError = (code: DomErrorCode, detail = '') => new Error(`${DOM_ERROR_PREFIX}${code}${detail ? ` ${detail}` : ''}`)

interface AuthJson {
  token?: string
  refreshToken?: string
  expiresIn?: number | string
  user?: { email?: string }
}

interface QuotaJson {
  quota?: { tier?: string; percent_used?: number; resets_at?: string; is_unlimited?: boolean; allowed_models?: Array<{ id?: string; name?: string }> }
}

interface PersonaJson {
  id?: string | number
  name?: string
  description?: string
  avatar_url?: string
  preview_image_url?: string
  system_prompt?: string
  prompt?: string
  personality_traits?: { intimacy?: { boundaries?: unknown } }
  image_prompt?: string
  image_negative_prompt?: string
  loras?: unknown
  checkpoint?: string
}

export interface AlPersonaFull extends AlPersona {
  prompt: string
  limits: string[]
  imagePrompt: string
  imageNegative: string
  checkpoint: string
  loras: DomLora[]
}

const ttlMs = (v: AuthJson['expiresIn']) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 15 * 60_000
}

export class AgenticLover {
  private access: string | null = null
  private accessUntil = 0
  private refreshing: Promise<string> | null = null
  private session = 0
  private email: string

  constructor(private readonly db: DomDb) {
    this.email = db.meta('alEmail') ?? ''
  }

  get signedIn(): boolean {
    return this.refreshToken() !== null
  }

  private refreshToken(): string | null {
    const sealed = this.db.meta('alRefresh')
    if (!sealed || !safeStorage.isEncryptionAvailable()) return this.memoryRefresh
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  private memoryRefresh: string | null = null

  private keep(json: AuthJson) {
    if (!json.token || !json.refreshToken) throw domError('server', 'no token')
    this.access = json.token
    this.accessUntil = Date.now() + ttlMs(json.expiresIn)
    if (safeStorage.isEncryptionAvailable()) this.db.setMeta('alRefresh', safeStorage.encryptString(json.refreshToken).toString('base64'))
    else this.memoryRefresh = json.refreshToken
    if (json.user?.email) {
      this.email = json.user.email
      this.db.setMeta('alEmail', this.email)
    }
  }

  async login(email: string, password: string) {
    const res = await fetch(`${AGENTIC_LOVER_API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
    const json = (await res.json().catch(() => ({}))) as AuthJson & { error?: string; message?: string }
    if (!res.ok) throw new Error(json.error ?? json.message ?? `${res.status}`)
    this.email = email
    this.db.setMeta('alEmail', email)
    this.keep(json)
  }

  async register(email: string, username: string, password: string) {
    const res = await fetch(`${AGENTIC_LOVER_API}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username, password }) })
    const json = (await res.json().catch(() => ({}))) as AuthJson & { error?: string; message?: string }
    const message = json.error ?? json.message ?? `${res.status}`
    if (res.status === 409 && !/username/i.test(message)) throw domError('emailTaken')
    if (!res.ok) throw new Error(message)
    this.email = email
    this.db.setMeta('alEmail', email)
    this.keep(json)
  }

  loginWith(provider: 'google' | 'discord', parent: BrowserWindow): Promise<void> {
    const start = provider === 'google'
      ? `${AGENTIC_LOVER_API}/api/auth/google?state=${encodeURIComponent(Buffer.from(JSON.stringify({ frontend_url: FRONTEND })).toString('base64'))}`
      : `${AGENTIC_LOVER_API}/api/auth/discord?frontend_url=${encodeURIComponent(FRONTEND)}`
    const win = new BrowserWindow({ parent, modal: true, width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: 'persist:agenticlover-oauth' } })
    return new Promise((resolve, reject) => {
      let done = false
      const catchCallback = (url: string) => {
        if (done) return
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          return
        }
        if (parsed.pathname.endsWith('/login') && parsed.searchParams.has('error')) {
          done = true
          win.close()
          reject(new Error(parsed.searchParams.get('error') ?? 'login failed'))
          return
        }
        if (!parsed.pathname.endsWith('/auth/callback')) return
        done = true
        const token = parsed.searchParams.get('token')
        const refreshToken = parsed.searchParams.get('refreshToken')
        win.close()
        if (!token || !refreshToken) return reject(new Error('login failed'))
        this.keep({ token, refreshToken })
        void this.fetchEmail().finally(resolve)
      }
      win.webContents.on('will-redirect', (_e, url) => catchCallback(url))
      win.webContents.on('will-navigate', (_e, url) => catchCallback(url))
      win.webContents.on('did-navigate', (_e, url) => catchCallback(url))
      win.on('closed', () => {
        if (!done) reject(new Error('cancelled'))
      })
      void win.loadURL(start)
    })
  }

  async profile(): Promise<{ name: string; pronouns: string; genitals: string }> {
    const json = (await this.call('/api/auth/me')) as { user?: { nickname?: string; username?: string; pronouns?: string; genitals?: string } }
    const u = json.user ?? {}
    return { name: u.nickname ?? '', pronouns: u.pronouns ?? '', genitals: u.genitals ?? '' }
  }

  private async fetchEmail() {
    try {
      const json = (await this.call('/api/auth/me')) as { user?: { email?: string }; email?: string }
      const email = json.user?.email ?? json.email
      if (email) {
        this.email = email
        this.db.setMeta('alEmail', email)
      }
    } catch {
    }
  }

  logout() {
    this.session++
    this.access = null
    this.memoryRefresh = null
    this.db.setMeta('alRefresh', null)
    this.db.setMeta('alEmail', null)
    this.email = ''
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.accessUntil - EXPIRY_MARGIN_MS) return this.access
    this.refreshing ??= (async () => {
      const refreshToken = this.refreshToken()
      if (!refreshToken) throw domError('signedOut')
      const session = this.session
      let res: Response
      try {
        res = await fetch(`${AGENTIC_LOVER_API}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) })
      } catch (error) {
        throw domError('network', String(error))
      }
      if (session !== this.session) throw domError('signedOut')
      if (res.status === 401 || res.status === 403) {
        this.logout()
        throw domError('signedOut')
      }
      if (!res.ok) throw domError('server', `${res.status}`)
      this.keep((await res.json()) as AuthJson)
      return this.access ?? ''
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async call(path: string, init: RequestInit & { freeMinutes?: boolean } = {}, retried = false): Promise<unknown> {
    const { freeMinutes, ...rest } = init
    const headers = new Headers(rest.headers)
    headers.set('Authorization', `Bearer ${await this.token()}`)
    headers.set('X-AG-Client', 'betterplayer')
    if (freeMinutes) headers.set('X-BP-Free-Minutes', '1')
    if (rest.body) headers.set('Content-Type', 'application/json')
    let res: Response
    try {
      res = await fetch(`${AGENTIC_LOVER_API}${path}`, { ...rest, headers })
    } catch (error) {
      throw domError('network', String(error))
    }
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) return body
    const code = typeof body === 'object' && body !== null && 'code' in body ? String(body.code) : ''
    const nested = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error ? String(body.error.code) : ''
    const reason = code || nested
    if (res.status === 401) {
      this.access = null
      if (!retried && this.signedIn) return this.call(path, init, true)
      throw domError('signedOut')
    }
    if (reason === 'betterplayer_free_time_used') throw domError('freeTimeUsed')
    if (reason === 'quota_exceeded' || reason === 'built_in_limit' || res.status === 429) throw domError('quota')
    if (reason === 'model_not_allowed') throw domError('model')
    if (reason === 'content_blocked') throw domError('blocked')
    throw domError('server', `${res.status} ${reason}`)
  }

  async account(freeMinutes: boolean): Promise<DomAccount> {
    const [quota, free] = await Promise.all([
      this.call('/api/ag-cloud/quota') as Promise<QuotaJson>,
      freeMinutes ? (this.call('/api/betterplayer/free-time') as Promise<{ remaining_seconds?: number }>) : Promise.resolve(null),
    ])
    const q = quota.quota ?? {}
    const models: AlModel[] = (q.allowed_models ?? []).flatMap((m) => (m.id ? [{ id: m.id, label: m.name ?? m.id }] : []))
    return {
      signedIn: true,
      email: this.email,
      tier: TIERS.find((t) => t === q.tier) ?? 'free',
      tokensLeft: q.is_unlimited ? 1 : Math.max(0, 1 - (q.percent_used ?? 0) / 100),
      resetsAt: q.resets_at ? Date.parse(q.resets_at) : null,
      freeSecondsLeft: free ? Math.max(0, free.remaining_seconds ?? DOM_FREE_SECONDS) : null,
      models,
    }
  }

  async heartbeat(seconds: number): Promise<number> {
    const json = (await this.call('/api/betterplayer/heartbeat', { method: 'POST', body: JSON.stringify({ seconds }) })) as { remaining_seconds?: number }
    return Math.max(0, json.remaining_seconds ?? 0)
  }

  async chat(model: string, messages: ChatMessage[], tools: ChatTool[], freeMinutes: boolean): Promise<ChatReply> {
    const json = (await this.call('/api/ag-cloud/chat/completions', {
      method: 'POST',
      freeMinutes,
      body: JSON.stringify({ ...(model ? { model } : {}), messages, tools, stream: false, temperature: 0.9, max_tokens: 800 }),
    })) as OpenAiJson
    return replyOf(json)
  }

  async personas(source: 'mine' | 'directory', query: string): Promise<AlPersona[]> {
    if (source === 'mine') {
      const json = (await this.call('/api/personas')) as { personas?: PersonaJson[] }
      return (json.personas ?? []).map(toPersona)
    }
    const q = new URLSearchParams({ sort: 'popular', limit: '50', ...(query.trim() ? { q: query.trim() } : {}) })
    const json = (await this.call(`/api/persona-directory?${q}`)) as { personas?: PersonaJson[]; characters?: PersonaJson[] }
    return (json.personas ?? json.characters ?? []).map(toPersona)
  }

  async persona(source: 'mine' | 'directory', id: string): Promise<AlPersonaFull> {
    const json = source === 'directory'
      ? ((await this.call(`/api/persona-directory/${encodeURIComponent(id)}/import`, { method: 'POST' })) as { persona?: PersonaJson })
      : ((await this.call(`/api/personas/${encodeURIComponent(id)}`)) as { persona?: PersonaJson } & PersonaJson)
    const p: PersonaJson = json.persona ?? (json as PersonaJson)
    const boundaries = p.personality_traits?.intimacy?.boundaries
    return {
      ...toPersona(p),
      prompt: p.system_prompt ?? p.prompt ?? '',
      limits: Array.isArray(boundaries) ? boundaries.filter((b): b is string => typeof b === 'string') : [],
      imagePrompt: p.image_prompt ?? '',
      imageNegative: p.image_negative_prompt ?? '',
      checkpoint: p.checkpoint ?? '',
      loras: normalizeLoras(p.loras),
    }
  }

  async memories(personaId: string): Promise<AlMemoryJson[]> {
    const json = (await this.call(`/api/memories?persona_id=${encodeURIComponent(personaId)}&memory_type=user&limit=200`)) as { data?: AlMemoryJson[] }
    return json.data ?? []
  }

  async addMemory(personaId: string, kind: string, content: string): Promise<AlMemoryJson> {
    const json = (await this.call('/api/memories', { method: 'POST', body: JSON.stringify({ persona_id: personaId, memory_type: 'user', memory_kind: kind, content, importance: 0.7 }) })) as { data?: AlMemoryJson }
    if (!json.data) throw domError('server', 'no memory')
    return json.data
  }

  async deleteMemory(id: string) {
    await this.call(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async image(prompt: string, negative: string): Promise<string> {
    const json = (await this.call('/api/ag-cloud/image/generate', { method: 'POST', body: JSON.stringify({ prompt, negative_prompt: negative, width: 640, height: 960 }) })) as { image_url?: string }
    if (!json.image_url) throw domError('server', 'no image')
    return dataUrl(json.image_url)
  }

  async avatar(url: string): Promise<string> {
    return url ? dataUrl(url).catch(() => '') : ''
  }
}

interface OpenAiJson {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatReply['toolCalls'] } }>
}

export function replyOf(json: OpenAiJson): ChatReply {
  const message = json.choices?.[0]?.message
  return { content: (message?.content ?? '').trim(), toolCalls: message?.tool_calls ?? [] }
}

const toPersona = (p: PersonaJson): AlPersona => ({ id: String(p.id ?? ''), name: p.name ?? '', description: p.description ?? '', avatarUrl: p.avatar_url ?? p.preview_image_url ?? '' })

async function dataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  const res = await fetch(url)
  if (!res.ok) throw domError('server', `${res.status}`)
  const type = res.headers.get('content-type') ?? 'image/png'
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
}

// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { OWN_SERVERS, domAccess, type DomAccount, type DomAiSettings, type OwnModels, type OwnServerId } from '@shared/dom'

export type OwnServer = (typeof OWN_SERVERS)[number]

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '')

export const ownServerAt = (url: string): OwnServer | undefined => OWN_SERVERS.find((s) => s.url === trimUrl(url))
export const ownServerId = (url: string): OwnServerId => ownServerAt(url)?.id ?? 'custom'

export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host || url.trim()
  } catch {
    return url.trim().replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  }
}

export const serverName = (url: string) => ownServerAt(url)?.name ?? hostOf(url)

const NOT_CHAT = /(^|[/:._-])(embed|text-embedding|tts|whisper|transcribe|dall-e|image|moderation|rerank|realtime|audio|search|babbage|davinci)/i
export const isChatModel = (id: string) => !NOT_CHAT.test(id)

export const firstChatModel = (ids: readonly string[]) => ids.filter(isChatModel).sort((a, b) => a.localeCompare(b))[0] ?? ''

export interface ModelGroup {
  vendor: string
  ids: string[]
}

export interface ModelList {
  groups: ModelGroup[]
  hidden: number
  unlisted: string | null
  typed: string | null
}

export function listModels(all: readonly string[], query: string, showAll: boolean, current: string): ModelList {
  const q = query.trim()
  const lq = q.toLowerCase()
  const hits = all
    .filter((id) => (showAll || isChatModel(id) || id === current) && id.toLowerCase().includes(lq))
    .sort((a, b) => a.localeCompare(b))
  const byVendor = new Map<string, string[]>()
  for (const id of hits) {
    const vendor = id.includes('/') && !q.includes('/') ? id.slice(0, id.indexOf('/')) : ''
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), id])
  }
  const groups = [...byVendor].map(([vendor, ids]) => ({ vendor, ids })).sort((a, b) => (a.vendor === '' ? -1 : b.vendor === '' ? 1 : a.vendor.localeCompare(b.vendor)))
  return {
    groups,
    hidden: all.filter((id) => !isChatModel(id)).length,
    unlisted: !q && current && !all.includes(current) ? current : null,
    typed: q && !all.includes(q) ? q : null,
  }
}

export type DomBlock = 'notSetUp' | 'signIn' | 'freeUsed' | 'ownDown' | 'ownKey' | 'ownModel' | null

export function domBlock(ai: Pick<DomAiSettings, 'provider' | 'setupDone' | 'ownModel'>, account: Pick<DomAccount, 'signedIn' | 'freeSecondsLeft'>, subscribed: boolean, own: OwnModels | null): DomBlock {
  if (!ai.setupDone) return 'notSetUp'
  if (ai.provider === 'own') return own?.kind === 'unreachable' ? 'ownDown' : own?.kind === 'auth' ? 'ownKey' : ai.ownModel.trim() ? null : 'ownModel'
  const access = domAccess({ ai, account }, subscribed)
  return access === 'ok' ? null : access
}

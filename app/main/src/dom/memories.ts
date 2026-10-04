// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { DomMemory, DomMemoryKind } from '@shared/dom'

export interface AlMemoryJson {
  id: string | number
  memory_kind?: string
  content?: string
  created_at?: string
}

const LIKES = 'Likes: '
const DISLIKES = 'Dislikes: '
export const toAl = (kind: DomMemoryKind, content: string) => {
  switch (kind) {
    case 'like':
      return { kind: 'preference', content: `${LIKES}${content}` }
    case 'dislike':
      return { kind: 'preference', content: `${DISLIKES}${content}` }
    case 'limit':
      return { kind: 'boundary', content }
    case 'reaction':
      return { kind: 'emotion', content }
  }
}
export function fromAl(m: AlMemoryJson): DomMemory {
  const text = m.content ?? ''
  const createdAt = m.created_at ? Date.parse(m.created_at) : 0
  const base = { id: String(m.id), createdAt: Number.isFinite(createdAt) ? createdAt : 0 }
  if (m.memory_kind === 'preference' && text.startsWith(DISLIKES)) return { ...base, kind: 'dislike', content: text.slice(DISLIKES.length) }
  if (m.memory_kind === 'preference') return { ...base, kind: 'like', content: text.startsWith(LIKES) ? text.slice(LIKES.length) : text }
  if (m.memory_kind === 'boundary') return { ...base, kind: 'limit', content: text }
  return { ...base, kind: 'reaction', content: text }
}

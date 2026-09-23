// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { MessageKey } from './i18n'
import type { TrackAxesConfig, TrackSource } from './tracking'

export const GAME_KINDS = ['rhythm', 'motion'] as const
export type GameKind = (typeof GAME_KINDS)[number]
export const GAME_KIND_LABEL: Record<GameKind, MessageKey> = { rhythm: 'game.kind.rhythm', motion: 'game.kind.motion' }

export interface GameSettings {
  kind: GameKind
  ai: boolean
}

export const defaultGameSettings = (): GameSettings => ({ kind: 'rhythm', ai: true })

export interface GameSource {
  id: string
  name: string
  kind: 'window' | 'screen'
  thumbnail: string
}

export interface GameSources {
  sources: GameSource[]
  screenAccess: boolean
}

export const SYSTEM_AUDIO = 'system'

export function supportsGameSystemAudio(platform: string, release: string): boolean {
  if (platform === 'win32') return true
  if (platform !== 'darwin') return false
  const [major = 0, minor = 0] = release.split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 2)
}

export function gameSource(kind: GameKind, ai: boolean): TrackSource {
  if (kind === 'rhythm') return 'beat'
  return ai ? 'ai-motion' : 'video'
}

export function gameAxes(defaults: TrackAxesConfig, source: TrackSource): TrackAxesConfig {
  return Object.fromEntries(Object.entries(defaults).map(([id, a]) => [id, { ...a, source: a.source === 'off' ? 'off' : source }])) as TrackAxesConfig
}

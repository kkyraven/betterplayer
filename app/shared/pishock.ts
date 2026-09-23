// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { createTranslator, ENGLISH, type Translate } from './i18n'

export interface PiShockShocker {
  id: string
  clientId: number
  name: string
  hub: string
  paused: boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readPiShockUser(value: unknown, t: Translate = createTranslator('en', ENGLISH)): number {
  if (!object(value) || typeof value.UserID !== 'number' || !Number.isSafeInteger(value.UserID) || value.UserID <= 0 || value.UserID > 0xffffffff) {
    throw new Error(t('devices.pishock.invalidAccount'))
  }
  return value.UserID
}

export function readPiShockDevices(value: unknown, t: Translate = createTranslator('en', ENGLISH)): PiShockShocker[] {
  if (!Array.isArray(value)) throw new Error(t('devices.pishock.invalidDevices'))
  const result: PiShockShocker[] = []
  for (const hub of value) {
    if (
      !object(hub) ||
      typeof hub.clientId !== 'number' ||
      !Number.isSafeInteger(hub.clientId) ||
      hub.clientId <= 0 ||
      hub.clientId > 0xffffffff ||
      !Array.isArray(hub.shockers)
    )
      throw new Error(t('devices.pishock.invalidHub'))
    for (const shocker of hub.shockers) {
      if (
        !object(shocker) ||
        typeof shocker.shockerId !== 'number' ||
        !Number.isSafeInteger(shocker.shockerId) ||
        shocker.shockerId <= 0 ||
        shocker.shockerId > 0xffffffff ||
        typeof shocker.isPaused !== 'boolean'
      )
        throw new Error(t('devices.pishock.invalidShocker'))
      result.push({
        id: String(shocker.shockerId),
        clientId: hub.clientId,
        name: typeof shocker.name === 'string' ? shocker.name : `PiShock ${shocker.shockerId}`,
        hub: typeof hub.name === 'string' ? hub.name : '',
        paused: shocker.isPaused,
      })
    }
  }
  return result
}

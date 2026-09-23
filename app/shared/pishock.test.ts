// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { describe, expect, it } from 'vitest'
import { readPiShockDevices, readPiShockUser } from './pishock'

describe('PiShock discovery', () => {
  it('keeps the hub, shocker IDs and pause state', () => {
    expect(readPiShockUser({ UserID: 42 })).toBe(42)
    expect(readPiShockDevices([{ clientId: 12, name: 'Hub', shockers: [{ shockerId: 34, name: 'Collar', isPaused: true }] }])).toEqual([
      { clientId: 12, id: '34', name: 'Collar', hub: 'Hub', paused: true },
    ])
  })
  it('rejects errors, ambiguous IDs and missing pause states', () => {
    for (const value of ['Not authorized', {}, { UserID: -1 }, { UserID: 1.5 }, { UserID: 2 ** 32 }]) expect(() => readPiShockUser(value)).toThrow()
    for (const value of [{}, [{ clientId: 1, shockers: [{ shockerId: 2 }] }], [{ clientId: -1, shockers: [] }]])
      expect(() => readPiShockDevices(value)).toThrow()
  })
})

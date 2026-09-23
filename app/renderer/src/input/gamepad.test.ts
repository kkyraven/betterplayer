import { describe, expect, it } from 'vitest'
import { TV_BUTTONS, TV_DIRECT, padKind } from './gamepad'

describe('TV gamepad map', () => {
  it('maps the standard buttons to the shell keys', () => {
    expect(TV_BUTTONS[0]).toBe('Enter')
    expect(TV_BUTTONS[1]).toBe('Escape')
    expect(TV_BUTTONS[2]).toBe('ContextMenu')
    expect(TV_BUTTONS[9]).toBe('ContextMenu')
    expect(TV_BUTTONS[3]).toBe(' ')
    expect([TV_BUTTONS[4], TV_BUTTONS[5]]).toEqual(['[', ']'])
    expect([TV_BUTTONS[12], TV_BUTTONS[13], TV_BUTTONS[14], TV_BUTTONS[15]]).toEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
  })
  it('keeps triggers and View out of the key map', () => {
    for (const i of Object.values(TV_DIRECT)) expect(TV_BUTTONS[i]).toBeUndefined()
  })
})

describe('padKind', () => {
  it('reads the vendor or name', () => {
    expect(padKind('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox')
    expect(padKind('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation')
    expect(padKind('Wireless Controller (Vendor: 054c Product: 09cc)')).toBe('playstation')
    expect(padKind('8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6003)')).toBe('generic')
    expect(padKind(null)).toBe('none')
  })
})

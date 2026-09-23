import { describe, expect, it } from 'vitest'
import { ACCENTS, THEME_MODES, defaultTheme, effectiveTheme, resolveMode, themeVars, windowColours } from './theme'

describe('theme', () => {
  it('follows the OS only for System', () => {
    expect(resolveMode('system', true)).toBe('dark')
    expect(resolveMode('system', false)).toBe('light')
    expect(resolveMode('black', false)).toBe('black')
  })
  it('keeps the original look as the default', () => {
    expect(themeVars(defaultTheme(), false)).toMatchObject({
      '--bg': '#0a0c10',
      '--bg-2': '#10131a',
      '--accent': '#b7a3ff',
      '--accent-rgb': '183, 163, 255',
      '--accent-ink': '#15102a',
      '--accent-soft': 'rgba(183, 163, 255, 0.16)',
      '--wash-1': 'rgba(120, 90, 200, 0.16)',
      '--wash-2': 'rgba(60, 120, 200, 0.14)',
    })
  })
  it('deepens the accent on light surfaces and tints the surface toward the tint', () => {
    const vars = themeVars({ mode: 'light', accent: 'rose', tint: 'sky' }, true)
    expect(vars['--accent']).toBe('#af2368')
    expect(vars['--accent-ink']).toBe('#ffffff')
    expect(vars['--bg']).toBe('color-mix(in oklab, #f3f3f7, #185eb3 9%)')
    expect(vars['--wash-2']).toBe('rgba(24, 94, 179, 0.11)')
  })
  it('keeps Black true black and only tints its panels', () => {
    const vars = themeVars({ mode: 'black', accent: 'amber', tint: 'amber' }, true)
    expect(vars['--bg']).toBe('#000000')
    expect(vars['--bg-2']).toBe('color-mix(in oklab, #0a0a0c, #ffc86b 8%)')
    expect(vars['--wash-1']).toBe('rgba(200, 140, 50, 0)')
  })
  it.each(THEME_MODES)('keeps %s free and restores saved colours for supporters', (mode) => {
    const saved = { mode, accent: 'rose', tint: 'sky' } as const
    expect(effectiveTheme(saved, true)).toEqual({ mode, accent: 'violet', tint: 'none' })
    expect(effectiveTheme(saved, false)).toEqual({ mode, accent: 'rose', tint: 'sky' })
    expect(saved).toEqual({ mode, accent: 'rose', tint: 'sky' })
  })
  it('uses light colours for the light window frame', () => {
    expect(windowColours('light')).toEqual({ background: '#f3f3f7', text: '#16181d' })
  })
  it('keeps readable accent text and buttons for every scheme', () => {
    for (const mode of ['light', 'dark', 'black'] as const) {
      for (const accent of ACCENTS) {
        const vars = themeVars({ mode, accent, tint: 'none' }, false)
        expect(contrast(vars['--accent']!, vars['--accent-ink']!), `${mode}/${accent} button`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(vars['--accent']!, vars['--bg']!), `${mode}/${accent} text`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(vars['--media-accent']!, vars['--media-bg']!), `${mode}/${accent} media`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('uses the dark accent and tint around video, retaining true black in Black', () => {
    const theme = { accent: 'rose', tint: 'sky' } as const
    const light = themeVars({ ...theme, mode: 'light' }, false)
    const dark = themeVars({ ...theme, mode: 'dark' }, false)
    expect(light['--media-accent']).toBe(dark['--accent'])
    expect(light['--media-bg-2']).toBe(dark['--bg-2'])
    expect(themeVars({ ...theme, mode: 'black' }, false)['--media-bg']).toBe('#000000')
  })
})

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

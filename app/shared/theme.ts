export const THEME_MODES = ['system', 'light', 'dark', 'black'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
export const ACCENTS = ['violet', 'rose', 'coral', 'amber', 'mint', 'sky', 'mono'] as const
export type Accent = (typeof ACCENTS)[number]
export const TINTS = ['none', ...ACCENTS] as const
export type Tint = (typeof TINTS)[number]
export interface ThemeSettings {
  mode: ThemeMode
  accent: Accent
  tint: Tint
}
export const defaultTheme = (): ThemeSettings => ({ mode: 'dark', accent: 'violet', tint: 'none' })
export const effectiveTheme = (theme: ThemeSettings, free: boolean): ThemeSettings => (free ? { ...theme, accent: 'violet', tint: 'none' } : theme)

export type ResolvedMode = Exclude<ThemeMode, 'system'>
export const resolveMode = (mode: ThemeMode, systemDark: boolean): ResolvedMode => (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode)

const ACCENT_COLOURS: Record<Accent, { dark: string; light: string; wash: [string, string] }> = {
  violet: { dark: '#b7a3ff', light: '#593cc9', wash: ['120, 90, 200', '60, 120, 200'] },
  rose: { dark: '#ff9ec6', light: '#af2368', wash: ['200, 80, 140', '140, 80, 200'] },
  coral: { dark: '#ff9a7a', light: '#ad381a', wash: ['200, 90, 70', '200, 80, 120'] },
  amber: { dark: '#ffc86b', light: '#875400', wash: ['200, 140, 50', '200, 110, 60'] },
  mint: { dark: '#7fe6b8', light: '#087044', wash: ['50, 170, 120', '60, 160, 200'] },
  sky: { dark: '#8ccbff', light: '#185eb3', wash: ['60, 130, 210', '100, 90, 200'] },
  mono: { dark: '#e6e8ee', light: '#2b2e37', wash: ['120, 120, 140', '90, 90, 110'] },
}
const SURFACES: Record<ResolvedMode, { bg: string; bg2: string; text: string; tint: number; tintBg: boolean; wash: number }> = {
  light: { bg: '#f3f3f7', bg2: '#ffffff', text: '#16181d', tint: 9, tintBg: true, wash: 0.8 },
  dark: { bg: '#0a0c10', bg2: '#10131a', text: '#eef0f4', tint: 10, tintBg: true, wash: 1 },
  black: { bg: '#000000', bg2: '#0a0a0c', text: '#eef0f4', tint: 8, tintBg: false, wash: 0 },
}

const rgb = (hex: string) => (hex.slice(1).match(/../g) ?? []).map((h) => parseInt(h, 16)).join(', ')
const mix = (base: string, colour: string, percent: number) => `color-mix(in oklab, ${base}, ${colour} ${percent}%)`
export const accentColour = (accent: Accent, mode: ResolvedMode) => (mode === 'light' ? ACCENT_COLOURS[accent].light : ACCENT_COLOURS[accent].dark)

export function themeVars(theme: ThemeSettings, systemDark: boolean): Record<string, string> {
  const mode = resolveMode(theme.mode, systemDark)
  const media = schemeVars(theme, mode === 'black' ? 'black' : 'dark')
  return { ...schemeVars(theme, mode), ...Object.fromEntries(Object.entries(media).map(([name, value]) => [`--media-${name.slice(2)}`, value])) }
}

function schemeVars(theme: ThemeSettings, mode: ResolvedMode): Record<string, string> {
  const surface = SURFACES[mode]
  const accent = accentColour(theme.accent, mode)
  const tint = theme.tint === 'none' ? null : accentColour(theme.tint, mode)
  const [wash1, wash2] = ACCENT_COLOURS[theme.accent].wash
  return {
    '--bg': tint && surface.tintBg ? mix(surface.bg, tint, surface.tint) : surface.bg,
    '--bg-2': tint ? mix(surface.bg2, tint, surface.tint) : surface.bg2,
    '--accent': accent,
    '--accent-rgb': rgb(accent),
    '--accent-ink': mode === 'light' ? '#ffffff' : '#15102a',
    '--accent-soft': `rgba(${rgb(accent)}, 0.16)`,
    '--wash-1': `rgba(${wash1}, ${round(0.16 * surface.wash)})`,
    '--wash-2': `rgba(${tint ? rgb(tint) : wash2}, ${round(0.14 * surface.wash)})`,
  }
}
const round = (n: number) => Math.round(n * 100) / 100

export const windowColours = (mode: ResolvedMode) => ({ background: SURFACES[mode].bg, text: SURFACES[mode].text })

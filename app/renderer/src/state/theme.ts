import { useEffect, useState } from 'react'
import { resolveMode, themeVars, type ThemeSettings } from '@shared/theme'

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

export function useSystemDark() {
  const [dark, setDark] = useState(() => darkQuery().matches)
  useEffect(() => {
    const query = darkQuery()
    const onChange = () => setDark(query.matches)
    query.addEventListener('change', onChange)
    onChange()
    return () => query.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function applyTheme(theme: ThemeSettings, systemDark: boolean) {
  const root = document.documentElement
  root.dataset.theme = resolveMode(theme.mode, systemDark)
  for (const [name, value] of Object.entries(themeVars(theme, systemDark))) root.style.setProperty(name, value)
}

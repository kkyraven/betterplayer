import { useEffect, useState } from 'react'
import { effectiveTheme, resolveMode, themeVars, type ThemeSettings } from '@shared/theme'

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

export function applyTheme(theme: ThemeSettings, free: boolean, systemDark: boolean) {
  const active = effectiveTheme(theme, free)
  const root = document.documentElement
  root.dataset.theme = resolveMode(active.mode, systemDark)
  for (const [name, value] of Object.entries(themeVars(active, systemDark))) root.style.setProperty(name, value)
}

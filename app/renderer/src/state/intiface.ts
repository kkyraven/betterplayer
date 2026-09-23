import { useEffect, useState } from 'react'
import type { IntifaceState } from 'bp-engine'
import type { Settings } from '@shared/settings'
import type { BrowserTab } from '@shared/browser'
import { FAPTAP_HOST } from '@shared/tracking'
import { engine } from '@/engine/client'
import { t } from '@/state/i18n'
import { useSettings } from './settings'
import { useBrowser } from './browser'

type Config = Settings['intiface']

let applied: { enabled: boolean; port: number } | null = null
let startError: string | null = null
let retry: number | null = null

const RETRY_MS = 5000

function hasFaptapTab(tabs: BrowserTab[]): boolean {
  return tabs.some(({ url }) => {
    try {
      const page = new URL(url)
      return ['https:', 'http:'].includes(page.protocol) && page.hostname.replace(/^www\./, '') === FAPTAP_HOST
    } catch {
      return false
    }
  })
}

export function useIntifaceEnabled(): boolean {
  const enabled = useSettings((s) => s.settings?.intiface.alwaysOn ?? false)
  const faptap = useBrowser((s) => hasFaptapTab(s.tabs))
  return enabled || faptap
}

export function applyIntiface(config: Config) {
  const next = { enabled: config.alwaysOn || hasFaptapTab(useBrowser.getState().tabs), port: config.port }
  if (applied && applied.enabled === next.enabled && applied.port === next.port) return
  applied = next
  startError = null
  if (retry !== null) window.clearTimeout(retry)
  retry = null
  if (!next.enabled) {
    engine.stopIntiface()
    return
  }
  try {
    engine.startIntiface(next.port)
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e)
    retry = window.setTimeout(() => {
      applied = null
      const settings = useSettings.getState().settings
      if (settings) applyIntiface(settings.intiface)
    }, RETRY_MS)
  }
}

useSettings.subscribe((s) => {
  if (s.settings) applyIntiface(s.settings.intiface)
})

useBrowser.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  const settings = useSettings.getState().settings
  if (settings) applyIntiface(settings.intiface)
})

window.addEventListener('beforeunload', () => {
  if (retry !== null) window.clearTimeout(retry)
  engine.stopIntiface()
})

export interface IntifaceStatus {
  running: boolean
  state: IntifaceState | null
  error: string | null
}

const POLL_MS = 1000

export function useIntifaceStatus(): IntifaceStatus {
  const [status, setStatus] = useState<IntifaceStatus>(() => read())
  useEffect(() => {
    const t = window.setInterval(() => {
      const next = read()
      setStatus((prev) => (same(prev, next) ? prev : next))
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [])
  return status
}

export function isOwnIntiface(url: string, status: IntifaceStatus): boolean {
  if (!status.state) return false
  try {
    const u = new URL(url)
    const port = u.port === '' ? 80 : Number(u.port)
    return u.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && port === status.state.port
  } catch {
    return false
  }
}

export function intifaceStatusLine(enabled: boolean, port: number, status: IntifaceStatus): string {
  if (!enabled) return t('intiface.status.faptap')
  if (status.error) return status.error
  if (status.state?.client) return t('intiface.status.clientConnected', { client: status.state.client })
  return t('intiface.status.listening', { port })
}

function read(): IntifaceStatus {
  const state = engine.intifaceState()
  return { running: state !== null, state, error: startError }
}

function same(a: IntifaceStatus, b: IntifaceStatus): boolean {
  return a.running === b.running && a.error === b.error && a.state?.port === b.state?.port && a.state?.clients === b.state?.clients && a.state?.client === b.state?.client
}

import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { invoke } from '@/ipc'
import { t } from '@/state/i18n'
import './Recover.css'

const RELOADED_AT = 'bp-recovered-at'
const RELOAD_WINDOW_MS = 30_000

export function RecoverScreen() {
  return (
    <div className="recover">
      <p>{t('app.recover.message')}</p>
      <Button onClick={() => location.reload()}>{t('app.recover.restart')}</Button>
    </div>
  )
}

export class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    void invoke('app:reportError', `render: ${error.stack ?? String(error)}`)
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0)
    if (Date.now() - last > RELOAD_WINDOW_MS) {
      sessionStorage.setItem(RELOADED_AT, String(Date.now()))
      location.reload()
    }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <RecoverScreen />
  }
}

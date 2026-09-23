import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { ipcMessage } from '@/lib/errors'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import '@/components/ui/Prompt.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}


export function ServerDialog({ open, onOpenChange }: Props) {
  const t = useT()
  const addServer = useLibrary((s) => s.addServer)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (busy) return
    setUrl('')
    setUsername('')
    setPassword('')
    setError(null)
    onOpenChange(false)
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await addServer({ url: url.trim(), username, password })
      setBusy(false)
      close()
    } catch (err) {
      setBusy(false)
      setError(ipcMessage(err))
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title={t('library.server.add')} width={400}>
      <form className="prompt" onSubmit={(e) => void submit(e)}>
        <h2>{t('library.server.add')}</h2>
        <Field label={t('library.server.address')}>
          <input autoFocus className="input" placeholder="http://192.168.1.10:9999" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </Field>
        <Field label={t('library.server.username')} hint={t('library.server.usernameHint')}>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t('library.server.password')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </Field>
        {error && (
          <p className="server-error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
            {busy ? t('library.server.connecting') : t('common.add')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

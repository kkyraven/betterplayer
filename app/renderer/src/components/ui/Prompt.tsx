import { useEffect, useState, type FormEvent } from 'react'
import { useT } from '@/state/i18n'
import { Button } from './Button'
import { Modal } from './Modal'
import './Prompt.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body?: string
  placeholder?: string
  defaultValue?: string
  suggestions?: string[]
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: (value: string) => void
}

export function Prompt({ open, onOpenChange, title, body, placeholder, defaultValue = '', suggestions, confirmLabel, cancelLabel, danger, onConfirm }: Props) {
  const t = useT()
  const [value, setValue] = useState(defaultValue)
  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])
  const asksText = placeholder !== undefined
  const listId = suggestions ? `prompt-${title.replace(/\W+/g, '-')}` : undefined

  const close = () => {
    setValue(defaultValue)
    onOpenChange(false)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    if (asksText && !v) return
    onConfirm(v)
    close()
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title={title} width={360}>
      <form className="prompt" onSubmit={submit}>
        <h2>{title}</h2>
        {body && <p>{body}</p>}
        {asksText && (
          <>
            <input autoFocus className="input" placeholder={placeholder} aria-label={placeholder} list={listId} value={value} onChange={(e) => setValue(e.target.value)} />
            {listId && (
              <datalist id={listId}>
                {suggestions?.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </>
        )}
        <div className="actions">
          <Button variant="ghost" onClick={close}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button type="submit" variant={danger ? 'default' : 'primary'} className={danger ? 'btn-danger' : undefined}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

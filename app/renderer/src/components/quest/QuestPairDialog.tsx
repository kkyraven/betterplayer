import { useEffect, useState } from 'react'
import type { QuestPairPrompt } from '@shared/quest'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { PinInput } from '@/components/ui/PinInput'
import { invoke, on } from '@/ipc'
import { useT } from '@/state/i18n'

export function QuestPairDialog() {
  const t = useT()
  const [prompts, setPrompts] = useState<QuestPairPrompt[]>([])
  const [pin, setPin] = useState('')
  const [wrong, setWrong] = useState(false)
  useEffect(() => {
    void invoke('quest:prompts').then(setPrompts)
    return on('quest:prompts', setPrompts)
  }, [])
  const prompt = prompts[0]
  useEffect(() => {
    setPin('')
    setWrong(false)
  }, [prompt?.requestId])

  const type = (digits: string) => {
    setPin(digits)
    setWrong(false)
    if (!prompt || digits.length < 4) return
    void invoke('quest:pin', prompt.requestId, digits).then((result) => {
      if (result !== 'wrong') return
      setWrong(true)
      setPin('')
    })
  }
  const title = prompt ? t('quest.pair.title', { name: prompt.name }) : ''
  return (
    <Modal open={prompt !== undefined} onOpenChange={(open) => !open && prompt && void invoke('quest:decline', prompt.requestId)} title={title} width={360}>
      {prompt && (
        <div className="prompt">
          <h2>{title}</h2>
          <p className={wrong ? 'danger' : undefined} role={wrong ? 'alert' : undefined}>
            {wrong ? t('quest.pair.wrong') : t('quest.pair.body')}
          </p>
          <PinInput value={pin} onChange={type} label={t('quest.pair.body')} invalid={wrong} autoFocus />
          <div className="actions">
            <Button onClick={() => void invoke('quest:decline', prompt.requestId)}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { useEffect, useState } from 'react'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { invoke } from '@/ipc'
import { useDom } from '@/state/dom'
import { useT } from '@/state/i18n'

const SERVERS = [
  { value: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
] as const
type Server = (typeof SERVERS)[number]['value']

export function OwnAiFields() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const hasKey = useDom((s) => s.hasKey)
  const { setAi, setKey } = useDom.getState()
  const [models, setModels] = useState<string[]>([])
  const [key, setKeyDraft] = useState('')
  useEffect(() => {
    let live = true
    const timer = window.setTimeout(() => {
      void invoke('dom:ownModels', ai.ownUrl).then((list) => {
        if (!live) return
        setModels(list)
        const { ownModel } = useDom.getState().ai
        if (list[0] && !list.includes(ownModel)) void setAi({ ownModel: list[0] })
      })
    }, 400)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [ai.ownUrl, hasKey, setAi])
  const server = SERVERS.find((s) => s.url === ai.ownUrl.replace(/\/+$/, ''))?.value ?? ''
  const options = models.concat(models.includes(ai.ownModel) || !ai.ownModel ? [] : [ai.ownModel]).map((m) => ({ value: m, label: m }))
  return (
    <>
      <div className="prow">
        <span className="lbl">{t('dom.ai.server')}</span>
        <span className="spacer" />
        <Segmented<Server | ''> options={SERVERS} value={server} onChange={(v) => void setAi({ ownUrl: SERVERS.find((s) => s.value === v)?.url ?? ai.ownUrl })} label={t('dom.ai.server')} />
      </div>
      <div className="prow">
        <span className="lbl">{t('dom.ai.address')}</span>
        <span className="spacer" />
        <input className="input mono dom-url" value={ai.ownUrl} spellCheck={false} onChange={(e) => void setAi({ ownUrl: e.target.value })} />
      </div>
      <div className="prow">
        <span className="lbl">{t('dom.ai.key')}</span>
        <span className="spacer" />
        <input className="input mono dom-url" type="password" value={key} placeholder={hasKey ? '••••••••' : t('dom.ai.keyOptional')} onChange={(e) => setKeyDraft(e.target.value)} onBlur={() => {
          if (key) void setKey(key).then(() => setKeyDraft(''))
        }} />
      </div>
      <div className="prow">
        <span className="lbl">{t('dom.ai.model')}</span>
        <span className="spacer" />
        <Select options={options} value={ai.ownModel} onChange={(ownModel) => void setAi({ ownModel })} label={t('dom.ai.model')} disabled={options.length === 0} />
      </div>
    </>
  )
}

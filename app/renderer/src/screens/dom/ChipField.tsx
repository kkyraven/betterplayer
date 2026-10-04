// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useT } from '@/state/i18n'

interface Props {
  values: string[]
  onChange: (values: string[]) => void
  label: string
}

export function ChipField({ values, onChange, label }: Props) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const add = (e: FormEvent) => {
    e.preventDefault()
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <form className="dom-chips" onSubmit={add}>
      {values.map((v) => (
        <span key={v} className="dom-chip">
          {v}
          <button type="button" aria-label={`${t('common.remove')} ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <X />
          </button>
        </span>
      ))}
      <label className="dom-chip add">
        <Plus />
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add} placeholder={t('common.add')} aria-label={label} size={Math.max(4, draft.length + 1)} />
      </label>
    </form>
  )
}

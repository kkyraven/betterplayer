// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { useState } from 'react'
import { SUBSCRIBE_URL } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import { isFree, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import './ExportSupport.css'

const PLAYER_URL = 'https://kinkyraven.com/betterplayer'

export function ExportSupport() {
  const t = useT()
  const free = useAccount(isFree)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!free) return null

  const open = (url: string) => {
    setError(null)
    void electron.shell.openExternal(url).catch((error: unknown) => setError(ipcMessage(error)))
  }
  const copy = () => {
    try {
      electron.clipboard.writeText(t('export.support.credit', { url: PLAYER_URL }))
      setCopied(true)
      setError(null)
    } catch (error) {
      setError(ipcMessage(error))
    }
  }

  return (
    <div className="export-support">
      <p className="export-support-request">
        {t('export.support.request')}{' '}
        <a href={PLAYER_URL} onClick={(event) => { event.preventDefault(); open(PLAYER_URL) }}>kinkyraven.com/betterplayer</a>{' <3'}
      </p>
      <div className="export-support-actions">
        <Button variant="ghost" onClick={() => open(SUBSCRIBE_URL)}>{t('export.support.subscribe')}</Button>
        <Button variant="ghost" onClick={copy}>{t(copied ? 'common.copied' : 'export.support.copyCredit')}</Button>
      </div>
      {error && <p className="export-support-error" role="status">{error}</p>}
    </div>
  )
}

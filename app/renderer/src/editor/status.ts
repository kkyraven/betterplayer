import type { MessageKey } from '@shared/i18n'
import { fmtWhen } from '@/lib/format'

export interface FunscriptStatus {
  key: MessageKey
  when: string
  warn: boolean
  off: boolean
}

export function funscriptStatus(exportedAt: number | null, fileScript: boolean, behind: boolean, now = Date.now()): FunscriptStatus {
  if (exportedAt !== null) return { key: behind ? 'editor.status.behindExported' : 'editor.status.exported', when: fmtWhen(exportedAt, now), warn: behind, off: false }
  if (fileScript) return { key: behind ? 'editor.status.behind' : 'editor.status.onDisk', when: '', warn: behind, off: false }
  return { key: 'editor.status.notExported', when: '', warn: false, off: true }
}

import { create } from 'zustand'
import type { SettingsPageId } from '@/screens/settings/navigation'

export interface SettingsEdit {
  page: SettingsPageId
  target: string
}
interface Feedback {
  current: SettingsEdit | null
  errors: Record<string, { edit: SettingsEdit; message: string }>
}
export const useSettingsFeedback = create<Feedback>()(() => ({ current: null, errors: {} }))
export function editKey(edit: SettingsEdit) {
  return `${edit.page}:${edit.target}`
}
export function reportSettingsWrite(edits: SettingsEdit[], error?: unknown) {
  useSettingsFeedback.setState((s) => {
    const errors = { ...s.errors }
    for (const edit of edits) {
      if (error !== undefined) errors[editKey(edit)] = { edit, message: error instanceof Error ? error.message : String(error) }
      else delete errors[editKey(edit)]
    }
    return { errors }
  })
}

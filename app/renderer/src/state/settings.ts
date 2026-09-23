import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { RECENT_MAX, type PerVideoSettings, type Settings } from '@shared/settings'
import { invoke } from '@/ipc'
import { setLanguage } from './i18n'
import { useUi } from './ui'
import { editKey, reportSettingsWrite, useSettingsFeedback, type SettingsEdit } from './settingsFeedback'

interface SettingsState {
  settings: Settings | null
  load: () => Promise<Settings>
  update: (change: (current: Settings) => Settings) => Promise<void>
  updateDebounced: (change: (current: Settings) => Settings) => void
  addRecent: (path: string) => Promise<void>
}

export function useVideoSettings(path: string | null): PerVideoSettings | null {
  const [video, setVideo] = useState<PerVideoSettings | null>(null)
  useEffect(() => {
    setVideo(null)
    if (!path) return
    let current = true
    void invoke('video:get', path).then((v) => {
      if (current) setVideo(v)
    })
    return () => {
      current = false
    }
  }, [path])
  return video
}

function applyShell(settings: Settings) {
  useUi.getState().setReduceTransparency(settings.appearance.reduceTransparency)
  void setLanguage(settings.general.language)
}

export const useSettings = create<SettingsState>()((set, get) => {
  let persistTimer = 0
  const pending = new Map<string, SettingsEdit>()
  let writes: Promise<void> = Promise.resolve()
  const rememberEdit = () => {
    const edit = useUi.getState().screen === 'settings' ? useSettingsFeedback.getState().current : null
    if (edit) pending.set(editKey(edit), edit)
  }
  const persist = () => {
    window.clearTimeout(persistTimer)
    const settings = get().settings
    if (!settings) return Promise.resolve()
    const edits = [...pending.values()]
    pending.clear()
    const write = writes.then(async () => {
      try {
        await invoke('settings:set', settings)
        reportSettingsWrite([...edits, ...Object.values(useSettingsFeedback.getState().errors).map(({ edit }) => edit)])
      } catch (error) {
        reportSettingsWrite(edits, error)
        throw error
      }
    })
    writes = write.catch(() => undefined)
    return write
  }
  const apply = (change: (current: Settings) => Settings, current: Settings) => {
    const next = change(current)
    set({ settings: next })
    applyShell(next)
  }

  return {
    settings: null,
    load: async () => {
      const settings = await invoke('settings:get')
      set({ settings })
      applyShell(settings)
      return settings
    },
    update: (change) => {
      rememberEdit()
      const update = async () => {
        apply(change, get().settings ?? (await get().load()))
        await persist()
      }
      const result = update()
      void result.catch(() => undefined)
      return result
    },
    updateDebounced: (change) => {
      const current = get().settings
      if (!current) return
      rememberEdit()
      apply(change, current)
      window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(() => { void persist().catch(() => undefined) }, 300)
    },
    addRecent: (path) =>
      get().update((s) => ({
        ...s,
        general: { ...s.general, recent: [path, ...s.general.recent.filter((p) => p !== path)].slice(0, RECENT_MAX) },
      })),
  }
})

import { Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { defaultShortcuts } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { ACTIONS, ACTION_IDS, EDITOR_PREFIX, bindingLabel, bindingsFor, captureNext, type ActionId, type Where } from '@/input/actions'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

const GROUPS: ReadonlyArray<{ where: Where; title: MessageKey }> = [
  { where: 'player', title: 'settings.shortcuts.player' },
  { where: 'editor', title: 'settings.shortcuts.editor' },
  { where: 'any', title: 'settings.shortcuts.everywhere' },
]

export function ShortcutsSettings() {
  const t = useT()
  const shortcuts = useSettings((s) => s.settings?.shortcuts)
  const update = useSettings((s) => s.update)
  const [capturing, setCapturing] = useState<ActionId | null>(null)

  useEffect(() => {
    if (!capturing) return
    const cancel = captureNext((key) => {
      const stored = ACTIONS[capturing].where === 'editor' ? EDITOR_PREFIX + key : key
      if (key !== 'escape') void update((s) => ({ ...s, shortcuts: { ...s.shortcuts, [stored]: capturing } }))
      setCapturing(null)
    })
    return cancel
  }, [capturing, update])

  const remove = (key: string) =>
    void update((s) => {
      const { [key]: _dropped, ...rest } = s.shortcuts
      return { ...s, shortcuts: rest }
    })

  if (!shortcuts) return null
  return (
    <>
      {GROUPS.map((g) => (
        <div key={g.where} className="section" data-setting={g.where === 'player' ? 'shortcut-bindings' : undefined} tabIndex={-1}>
          <div className="sec-hd">
            <h2>{t(g.title)}</h2>
          </div>
          <div className="panel">
            {ACTION_IDS.filter((id) => ACTIONS[id].where === g.where).map((id) => {
              const keys = bindingsFor(id)
              return (
                <div key={id} className="prow">
                  <span className="lbl">{t(ACTIONS[id].label)}</span>
                  <span className="spacer" />
                  <span className="keys">
                    {keys.map((k) => (
                      <span key={k} className="key">
                        {bindingLabel(k)}
                        <button type="button" aria-label={t('settings.shortcuts.remove', { binding: bindingLabel(k) })} onClick={() => remove(k)}>
                          <X />
                        </button>
                      </span>
                    ))}
                    {capturing === id ? (
                      <span className="key waiting">{t('settings.shortcuts.pressKey')}</span>
                    ) : (
                      <Button icon aria-label={t('settings.shortcuts.addFor', { action: t(ACTIONS[id].label) })} title={t('settings.shortcuts.add')} onClick={() => setCapturing(id)}>
                        <Plus />
                      </Button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="set-foot">
        <Button variant="ghost" onClick={() => void update((s) => ({ ...s, shortcuts: defaultShortcuts() }))}>
          {t('settings.shortcuts.reset')}
        </Button>
      </div>
    </>
  )
}

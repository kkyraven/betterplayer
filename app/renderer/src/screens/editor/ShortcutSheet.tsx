import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { ACTIONS, ACTION_IDS, EDITOR_PREFIX, bindingLabel, bindingsFor, captureNext, type ActionId } from '@/input/actions'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

const EDITOR_ACTIONS = ACTION_IDS.filter((id) => ACTIONS[id].where === 'editor')

const GROUPS: [MessageKey, RegExp][] = [
  ['editor.shortcuts.group.playback', /^Editor\.(Play|Speed|Loop\.(In|Out|Toggle))/],
  ['editor.shortcuts.group.navigate', /^Editor\.(Frame|Point\.(Next|Previous)|Cut\.|Marker|Flag\.(Next|Previous)|Lane)/],
  ['editor.shortcuts.group.place', /^Editor\.(Point|Tool|Record|Ghost)/],
  ['editor.shortcuts.group.select', /^Editor\.(Select|Escape)/],
  ['editor.shortcuts.group.edit', /^Editor\.(Delete|Move|Undo|Redo|Cut|Copy|Paste|Invert|Reverse|Flatten|Simplify|Scale|RangeExtend|Loop|Quantise|LimitSpeed)/],
  ['editor.shortcuts.group.fill', /^Editor\.(Fill|AiFill|Refit|OtherAxes)/],
  ['editor.shortcuts.group.mark', /^Editor\.(Bookmark|Flag|Chapter|Metadata)/],
  ['editor.shortcuts.group.view', /^Editor\.(Zoom|Linked|Snap)/],
  ['editor.shortcuts.group.file', /^Editor\.(Save|Export|Shortcuts)/],
]
const groupOf = (id: ActionId): MessageKey => GROUPS.find(([, re]) => re.test(id))?.[0] ?? 'editor.shortcuts.group.other'
const SECTIONS = [...GROUPS.map(([name]) => name), 'editor.shortcuts.group.other' as const].map((name) => ({ name, ids: EDITOR_ACTIONS.filter((id) => groupOf(id) === name) })).filter((s) => s.ids.length > 0)

export function ShortcutSheet() {
  const t = useT()
  const open = useEditor((s) => s.sheet === 'shortcuts')
  const setSheet = useEditor((s) => s.setSheet)
  const shortcuts = useSettings((s) => s.settings?.shortcuts)
  const update = useSettings((s) => s.update)
  const [capturing, setCapturing] = useState<{ id: ActionId; replace: string | null } | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!capturing) return
    const { id, replace } = capturing
    const cancel = captureNext((key) => {
      setCapturing(null)
      if (key === 'escape') return
      void update((s) => {
        const next = { ...s.shortcuts }
        if (replace) delete next[replace]
        next[EDITOR_PREFIX + key] = id
        return { ...s, shortcuts: next }
      })
    })
    return cancel
  }, [capturing, update])

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (id: ActionId) => !q || t(ACTIONS[id].label).toLowerCase().includes(q) || bindingsFor(id).some((k) => bindingLabel(k).toLowerCase().includes(q))
    return SECTIONS.map((s) => ({ ...s, ids: s.ids.filter(matches) })).filter((s) => s.ids.length > 0)
  }, [query, shortcuts, t])

  if (!shortcuts) return null
  return (
    <Modal open={open} onOpenChange={(o) => !o && setSheet(null)} title={t('editor.shortcuts.title')} width={520}>
      <div className="ed-sheet">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{t('editor.shortcuts.title')}</h3>
          <IconButton label={t('common.close')} size="sm" onClick={() => setSheet(null)}>
            <X />
          </IconButton>
        </div>
        <label className="ed-search">
          <Search />
          <input type="search" value={query} placeholder={t('editor.shortcuts.search')} aria-label={t('editor.shortcuts.search')} autoFocus onChange={(ev) => setQuery(ev.target.value)} />
        </label>
        <div className="rows">
          {sections.length === 0 && <div className="none">{t('editor.shortcuts.noMatches')}</div>}
          {sections.map((section) => (
            <div key={section.name}>
              <div className="group-hd">{t(section.name)}</div>
              {section.ids.map((id) => {
                const label = t(ACTIONS[id].label)
                const keys = bindingsFor(id)
                return (
                  <div key={id} className="row">
                    <span>{label}</span>
                    <span className="keys">
                      {keys.map((k) => {
                        const waiting = capturing?.id === id && capturing.replace === k
                        return (
                          <button key={k} type="button" className={`key${waiting ? ' waiting' : ''}`} title={t('editor.shortcuts.clickToRebind')} aria-label={t('editor.shortcuts.rebind', { label, key: bindingLabel(k) })} onClick={() => setCapturing({ id, replace: k })}>
                            {waiting ? t('editor.shortcuts.pressAKey') : bindingLabel(k)}
                          </button>
                        )
                      })}
                      {capturing?.id === id && capturing.replace === null ? (
                        <span className="key waiting">{t('editor.shortcuts.pressAKey')}</span>
                      ) : (
                        <button type="button" className="key add" title={t('editor.shortcuts.addKey')} aria-label={t('editor.shortcuts.addKeyFor', { label })} onClick={() => setCapturing({ id, replace: null })}>
                          +
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="acts">
          <Button variant="ghost" onClick={() => setSheet(null)}>
            {t('common.done')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

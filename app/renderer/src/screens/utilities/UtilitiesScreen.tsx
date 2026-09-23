import { Link, PencilRuler, type LucideIcon } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { useUi } from '@/state/ui'
import { Matcher } from './Matcher'
import '@/components/ui/Prompt.css'
import './utilities.css'

const TOOLS = [{ id: 'matcher', label: 'utilities.matcher', icon: Link, screen: Matcher }] as const satisfies ReadonlyArray<{
  id: string
  label: MessageKey
  icon: LucideIcon
  screen: ComponentType
}>

type ToolId = (typeof TOOLS)[number]['id']

export function UtilitiesScreen() {
  const t = useT()
  const [current, setCurrent] = useState<ToolId>('matcher')
  const [alpha, setAlpha] = useState(false)
  const setScreen = useUi((s) => s.setScreen)
  const tool = TOOLS.find((t) => t.id === current) ?? TOOLS[0]
  const Page = tool.screen
  return (
    <>
      <aside className="side-list">
        <h1>{t('screen.utilities')}</h1>
        <ul>
          {TOOLS.map((tool) => (
            <li key={tool.id}>
              <button type="button" className={cx('side-row', tool.id === current && 'on')} onClick={() => setCurrent(tool.id)} aria-current={tool.id === current ? 'true' : undefined}>
                <tool.icon />
                {t(tool.label)}
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="side-row" onClick={() => setAlpha(true)}>
              <PencilRuler />
              {t('utilities.scriptEditor')}
            </button>
          </li>
        </ul>
      </aside>
      <Page />
      <Modal open={alpha} onOpenChange={setAlpha} title={t('utilities.scriptEditor')} width={380}>
        <div className="prompt">
          <h2>{t('utilities.scriptEditor')}</h2>
          <p>
            {t('utilities.alpha.line1')}
            <br />
            {t('utilities.alpha.line2')}
          </p>
          <div className="actions">
            <Button variant="ghost" onClick={() => setAlpha(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                setAlpha(false)
                setScreen('editor')
              }}
            >
              {t('common.open')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

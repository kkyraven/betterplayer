import { Film } from 'lucide-react'
import { useState } from 'react'
import { ExportSupport } from '@/components/scripts/ExportSupport'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { useEditor, type ExportKind } from '@/state/editor'
import { useT } from '@/state/i18n'

export function ExportDialog() {
  const t = useT()
  const open = useEditor((s) => s.sheet === 'export')
  const setSheet = useEditor((s) => s.setSheet)
  const title = useEditor((s) => s.title)
  const lanes = useEditor((s) => s.lanes.filter((l) => l.points.length > 0).length)
  const exportScripts = useEditor((s) => s.exportScripts)
  const [kind, setKind] = useState<ExportKind>('sibling')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await exportScripts(kind)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onOpenChange={(o) => !o && setSheet(null)} title={t('editor.export.title')} width={440}>
      <div className="ed-sheet">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{t('editor.export.heading')}</h3>
        </div>
        <div className="export-file">
          <Film />
          <div style={{ minWidth: 0 }}>
            <strong>{title}</strong>
            <small>
              {t('editor.export.axes', { count: lanes })} · {kind === 'bundle' ? t('editor.export.oneBundleFile') : t('editor.export.files', { count: lanes })}
            </small>
          </div>
        </div>
        <div className="ed-field" style={{ marginBottom: 14 }}>
          <span>{t('editor.export.format')}</span>
          <Segmented<ExportKind>
            label={t('editor.export.format')}
            value={kind}
            options={[
              { value: 'sibling', label: t('editor.export.siblingFiles') },
              { value: 'bundle', label: t('editor.export.bundle') },
            ]}
            onChange={setKind}
          />
        </div>
        <ExportSupport />
        <div className="acts">
          <Button variant="ghost" onClick={() => setSheet(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || lanes === 0} onClick={() => void run()}>
            {t('editor.export.title')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

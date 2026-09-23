import { useEffect, useState } from 'react'
import { AXIS_NAME } from '@shared/axes'
import { OFS_FIELDS } from '@shared/editor'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'

const asText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

export function MetadataSheet() {
  const t = useT()
  const open = useEditor((s) => s.sheet === 'metadata')
  const setSheet = useEditor((s) => s.setSheet)
  const focused = useEditor((s) => s.focused)
  const lane = useEditor((s) => s.lanes.find((l) => l.axis === s.focused))
  const setMetadata = useEditor((s) => s.setMetadata)
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) setValues(Object.fromEntries(OFS_FIELDS.map((f) => [f.key, asText(lane?.metadata[f.key])])))
  }, [open, lane])

  const save = () => {
    const next: Record<string, unknown> = { ...(lane?.metadata ?? {}) }
    for (const f of OFS_FIELDS) {
      const text = (values[f.key] ?? '').trim()
      if (!text) {
        delete next[f.key]
        continue
      }
      next[f.key] = 'list' in f && f.list ? text.split(',').map((t) => t.trim()).filter(Boolean) : text
    }
    setMetadata(next)
    setSheet(null)
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && setSheet(null)} title={t('editor.metadata.title')} width={460}>
      <div className="ed-sheet">
        <h3>{t('editor.metadata.title')} · {t(AXIS_NAME[focused])}</h3>
        <div className="fields">
          {OFS_FIELDS.map((f) => (
            <Field key={f.key} label={t(f.label)}>
              {'long' in f && f.long ? (
                <textarea className="input" value={values[f.key] ?? ''} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })} />
              ) : (
                <input className="input" value={values[f.key] ?? ''} placeholder={'list' in f && f.list ? t('editor.metadata.commaSeparated') : undefined} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })} />
              )}
            </Field>
          ))}
        </div>
        <div className="acts">
          <Button variant="ghost" onClick={() => setSheet(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

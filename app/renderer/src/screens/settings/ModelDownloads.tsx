import { useEffect, useState } from 'react'
import type { ModelFileStatus, ModelInfo } from '@shared/tracking'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { invoke } from '@/ipc'
import { electron } from '@/node'
import { t, useT } from '@/state/i18n'
import { percent, useModels, type Download } from '@/state/models'

interface Props {
  models: readonly ModelInfo[]
  onChange?: () => void
  row?: (model: ModelInfo) => React.ReactNode
}

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function stateText(model: ModelInfo, bytes: number | null, d: Download | undefined): string {
  if (model.bundled) return bytes === null ? t('settings.models.missing') : t('settings.models.included')
  if (d?.status === 'running') return `${percent(d)}%`
  return bytes === null ? t('settings.models.notDownloaded') : fmtMb(bytes)
}

export function modelPresent(model: ModelInfo, status: Record<string, ModelFileStatus | null>): boolean {
  return model.files.every((f) => status[f.file])
}

export function ModelDownloads({ models, onChange, row }: Props) {
  const t = useT()
  const [status, setStatus] = useState<Record<string, ModelFileStatus | null>>({})
  const [consent, setConsent] = useState<ModelInfo | null>(null)
  const downloads = useModels((s) => s.downloads)
  const start = useModels((s) => s.download)
  const clear = useModels((s) => s.clear)

  const refresh = async () => {
    setStatus(await invoke('models:status', models.flatMap((m) => m.files.map((f) => f.file))))
    onChange?.()
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const finished = models.filter((m) => downloads[m.id]?.status === 'done')
  useEffect(() => {
    if (finished.length === 0) return
    for (const m of finished) clear(m.id)
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished.length])

  const download = (m: ModelInfo) => {
    setConsent(null)
    clear(m.id)
    void start(m)
  }
  const remove = async (m: ModelInfo) => {
    for (const file of m.files) await invoke('models:remove', file.file)
    await refresh()
  }
  const errors = models.map((m) => downloads[m.id]).filter((d): d is Extract<Download, { status: 'error' }> => d?.status === 'error')

  return (
    <>
      {models.map((m) => {
        const bytes = modelPresent(m, status) ? m.files.reduce((sum, f) => sum + (status[f.file]?.bytes ?? 0), 0) : null
        const d = downloads[m.id]
        return (
          <div key={m.id} className="prow">
            {row ? (
              row(m)
            ) : (
              <span>
                <div className="lbl">{m.label}</div>
                <div className="sub">
                  {m.sizeMb} MB ·{' '}
                  <a href={m.sourceUrl} className="link" onClick={(e) => { e.preventDefault(); void electron.shell.openExternal(m.sourceUrl) }}>
                    {t('settings.models.link')}
                  </a>
                </div>
              </span>
            )}
            <span className="spacer" />
            <span className="val">{stateText(m, bytes, d)}</span>
            {m.bundled ? null : bytes ? (
              <Button variant="ghost" onClick={() => void remove(m)}>
                {t('common.remove')}
              </Button>
            ) : (
              <Button disabled={d?.status === 'running'} onClick={() => (m.consent ? setConsent(m) : download(m))}>
                {t('settings.models.download')}
              </Button>
            )}
          </div>
        )
      })}
      {errors.map((d) => (
        <div key={d.error} className="prow error">
          {d.error}
        </div>
      ))}
      <Modal open={consent !== null} onOpenChange={(open) => !open && setConsent(null)} title={t('settings.models.downloadTitle')} width={440}>
        {consent && (
          <div className="sheet-body">
            <h3>{t('settings.models.downloadAsk', { model: consent.label })}</h3>
            <p>{t('settings.models.downloadBody', { size: consent.sizeMb, host: new URL(consent.files[0]?.url ?? consent.sourceUrl).host, licence: consent.licence })}</p>
            <div className="acts">
              <Button variant="ghost" onClick={() => setConsent(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => download(consent)}>
                {t('settings.models.download')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

import { useEffect, useState } from 'react'
import { PASSTHROUGH_MODELS, passthroughModelId, type PassthroughModel } from '@shared/passthrough'
import type { MessageKey } from '@shared/i18n'
import { Segmented } from '@/components/ui/Segmented'
import { invoke } from '@/ipc'
import { isFree, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { kinkyravenCatalog, percent, useModels } from '@/state/models'
import { useSettings } from '@/state/settings'

const LABELS: Record<PassthroughModel, MessageKey> = { people: 'settings.models.passthroughPeople', skin: 'settings.models.passthroughSkin' }

export function PassthroughModelRow() {
  const t = useT()
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const free = useAccount(isFree)
  const model = settings?.vr.passthroughModel ?? 'people'
  const id = passthroughModelId(settings?.tracking.models.detector, model)
  const download = useModels((s) => s.downloads[id])
  const [onDisk, setOnDisk] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const files = (await kinkyravenCatalog()).find((m) => m.id === id)?.files ?? []
      const status = files.length ? await invoke('models:status', files.map((f) => f.file)) : {}
      if (live) setOnDisk(files.length > 0 && files.every((f) => status[f.file]))
    })()
    return () => {
      live = false
    }
  }, [id, download?.status])

  const status =
    download?.status === 'running'
      ? `${percent(download)}%`
      : download?.status === 'error'
        ? t('settings.models.failed', { error: download.error })
        : t(onDisk ? 'settings.models.ready' : 'settings.models.notDownloaded')

  return (
    <div className="prow" data-setting="passthrough-model" tabIndex={-1}>
      <span>
        <div className="lbl">{t('settings.models.passthroughModel')}</div>
        <div className="sub">{free ? t('common.supporterOnly') : status}</div>
      </span>
      <span className="spacer" />
      <Segmented
        options={PASSTHROUGH_MODELS.map((value) => ({ value, label: t(LABELS[value]) }))}
        value={model}
        onChange={(value) => void update((s) => ({ ...s, vr: { ...s.vr, passthroughModel: value } }))}
        label={t('settings.models.passthroughModel')}
        disabled={free}
      />
    </div>
  )
}

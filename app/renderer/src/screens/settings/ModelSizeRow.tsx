import { MODEL_SIZES, MODEL_SIZE_LABELS, detectorId, sizeOf, skinId } from '@shared/censor'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { isFree, useAccount } from '@/state/account'
import { useCensor } from '@/state/censor'
import { useT } from '@/state/i18n'
import { percent, useModels } from '@/state/models'
import { useSettings } from '@/state/settings'

export function ModelSizeRow() {
  const t = useT()
  const size = sizeOf(useSettings((s) => s.settings?.tracking.models.detector))
  const detector = useCensor((s) => s.detector)
  const skin = useCensor((s) => s.skin)
  const running = useCensor((s) => s.running)
  const locked = useCensor((s) => s.locked)
  const setSize = useCensor((s) => s.setSize)
  const uninstall = useCensor((s) => s.uninstall)
  const downloads = useModels((s) => s.downloads)
  const free = useAccount(isFree)

  const fetching = size ? [downloads[detectorId(size)], downloads[skinId(size)]] : []
  const progress = fetching.find((d) => d?.status === 'running')
  const failed = fetching.find((d) => d?.status === 'error')
  const status = !size
    ? t('settings.models.notDownloaded')
    : progress
      ? `${percent(progress)}%`
      : failed?.status === 'error'
        ? t('settings.models.failed', { error: failed.error })
        : running?.status === 'error'
          ? t('settings.models.failed', { error: running.error ?? '' })
          : detector === 'installed'
            ? running?.status === 'ready'
              ? running.runMs > 0
                ? `${t('settings.models.ready')} · ${running.runMs} ms`
                : t('settings.models.ready')
              : running?.status === 'loading'
                ? t('settings.models.loading')
                : t('settings.models.ready')
            : t('settings.models.notDownloaded')
  const installed = detector === 'installed' || skin === 'installed'

  return (
    <div className="prow" data-setting="model-size" tabIndex={-1}>
      <span>
        <div className="lbl">{t('settings.censor.modelSize')}</div>
        <div className="sub">{status}</div>
      </span>
      <span className="spacer" />
      {failed && size && (
        <Button variant="ghost" onClick={() => void setSize(size)}>
          {t('settings.models.download')}
        </Button>
      )}
      {installed && (
        <Button variant="ghost" disabled={locked} onClick={() => void uninstall()}>
          {t('common.uninstall')}
        </Button>
      )}
      <Segmented
        options={MODEL_SIZES.map((value) => ({ value, label: t(MODEL_SIZE_LABELS[value]) }))}
        value={size ?? ''}
        onChange={(value) => value && void setSize(value)}
        label={t('settings.censor.modelSize')}
        disabled={free || locked}
      />
    </div>
  )
}

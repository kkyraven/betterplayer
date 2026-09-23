import { FRAME_GEN_LABELS, FRAME_GEN_TARGETS, UPSCALERS, UPSCALER_LABELS } from '@shared/settings'
import { TvRow } from '@/components/tv/TvRow'
import { enhanceCapabilities } from '@/engine/client'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'

export function UpscalingGroup() {
  const t = useT()
  const frameGenOptions = FRAME_GEN_TARGETS.map((v) => ({ value: v, label: t(FRAME_GEN_LABELS[v]) }))
  const upscaler = useSettings((s) => s.settings?.upscaling.upscaler ?? 'off')
  const frameGen = useSettings((s) => s.settings?.upscaling.frameGen ?? 'off')
  const setUpscaling = usePlayer((s) => s.setUpscaling)
  const upscalers = UPSCALERS.filter((u) => (u !== 'rtx' || enhanceCapabilities.vsr) && (u !== 'apple' || enhanceCapabilities.appleVsr)).map((u) => ({ value: u, label: t(UPSCALER_LABELS[u]) }))
  return (
    <>
      <TvRow kind="options" label={t('tv.upscaling.upscaler')} navFirst options={upscalers} value={upscaler} onChange={(upscaler) => setUpscaling({ upscaler })} />
      <TvRow kind="options" label={t('tv.quickSettings.frameGeneration')} options={frameGenOptions} value={frameGen} onChange={(frameGen) => setUpscaling({ frameGen })} />
    </>
  )
}

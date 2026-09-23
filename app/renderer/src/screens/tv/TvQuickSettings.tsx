import { RefreshCw } from 'lucide-react'
import { isAxisId } from '@shared/axes'
import { PROJECTION_KINDS, PROJECTION_LABELS, detectProjection } from '@shared/projection'
import type { MessageKey } from '@shared/i18n'
import { FRAME_GEN_OVERRIDES, UPSCALERS, UPSCALER_LABELS, type FrameGenOverride, type Upscaler } from '@shared/settings'
import { TvRow } from '@/components/tv/TvRow'
import { TvSheet } from '@/components/tv/TvSheet'
import { enhanceCapabilities } from '@/engine/client'
import { outputName, useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import { RATES, usePlayer, useScriptedAxes } from '@/state/player'
import { useSettings } from '@/state/settings'

const RATE_OPTIONS = RATES.map((r) => ({ value: r, label: `${r}×` }))
const FRAME_GEN_OPTIONS: ReadonlyArray<{ value: FrameGenOverride | 'default'; label: MessageKey }> = [
  { value: 'default', label: 'common.default' },
  ...FRAME_GEN_OVERRIDES.map((v) => ({ value: v, label: v === 'off' ? ('common.off' as const) : ('common.on' as const) })),
]
const PROJECTION_OPTIONS = PROJECTION_KINDS.map((k) => ({ value: k, label: PROJECTION_LABELS[k] }))

function useIntensity(): number {
  const scripted = useScriptedAxes()
  const first = scripted.find(isAxisId)
  const override = usePlayer((s) => (first ? s.video.axes[first]?.amplitude : undefined))
  const fallback = useSettings((s) => (first ? s.settings?.axesDefault[first].amplitude : undefined))
  return override ?? fallback ?? 1
}

export function TvQuickSettings() {
  const t = useT()
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)
  const adjustAmplitude = usePlayer((s) => s.adjustAmplitude)
  const intensity = useIntensity()
  const offsetMs = usePlayer((s) => s.video.globalOffsetMs)
  const setGlobalOffset = usePlayer((s) => s.setGlobalOffset)
  const rate = usePlayer((s) => s.snapshot.rate)
  const setRate = usePlayer((s) => s.setRate)
  const subtitles = useSettings((s) => s.settings?.subtitles.enabled ?? true)
  const update = useSettings((s) => s.update)
  const upscaler = useSettings((s) => s.settings?.upscaling.upscaler ?? 'off')
  const setUpscaling = usePlayer((s) => s.setUpscaling)
  const frameGen = usePlayer((s) => s.video.frameGen ?? 'default')
  const setFrameGen = usePlayer((s) => s.setFrameGen)
  const projection = usePlayer((s) => s.projection)
  const vr = usePlayer((s) => s.video.projection !== undefined || detectProjection(s.title).kind !== 'flat')
  const setProjection = usePlayer((s) => s.setProjection)
  const outputs = useDevices((s) => s.outputs)
  const states = useDevices((s) => s.states)
  const reconnect = useDevices((s) => s.reconnect)
  const upscalers = UPSCALERS.filter((u) => (u !== 'rtx' || enhanceCapabilities.vsr) && (u !== 'apple' || enhanceCapabilities.appleVsr)).map((u: Upscaler) => ({ value: u, label: t(UPSCALER_LABELS[u]) }))
  return (
    <TvSheet title={t('tv.quickSettings.title')}>
      <TvRow kind="number" label={t('tv.quickSettings.volume')} navFirst value={Math.round(volume * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => setVolume(v / 100)} />
      <TvRow kind="number" label={t('tv.quickSettings.intensity')} value={Math.round(intensity * 100)} min={0} max={200} step={5} format={(v) => `${v}%`} onChange={(v) => adjustAmplitude(v / 100 - intensity)} />
      <TvRow kind="number" label={t('tv.quickSettings.scriptOffset')} value={offsetMs} min={-5000} max={5000} step={10} holdStep={10} format={(v) => `${v} ms`} onChange={setGlobalOffset} />
      <TvRow kind="options" label={t('tv.quickSettings.speed')} options={RATE_OPTIONS} value={rate} onChange={setRate} />
      <TvRow kind="switch" label={t('tv.quickSettings.subtitles')} value={subtitles} onChange={(enabled) => void update((s) => ({ ...s, subtitles: { ...s.subtitles, enabled } }))} />
      <TvRow kind="options" label={t('tv.quickSettings.upscaling')} options={upscalers} value={upscaler} onChange={(u) => setUpscaling({ upscaler: u })} />
      {enhanceCapabilities.frameGen && <TvRow kind="options" label={t('tv.quickSettings.frameGeneration')} options={FRAME_GEN_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} value={frameGen} onChange={(v) => setFrameGen(v === 'default' ? null : v)} />}
      {vr && (
        <TvRow kind="options" label={t('tv.quickSettings.projection')} options={PROJECTION_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} value={projection.kind} onChange={(kind) => setProjection({ ...projection, kind, layout: kind === 'flat' ? 'mono' : projection.layout })} />
      )}
      {outputs.map((o) => {
        const state = states[o.id]
        const status = state?.status === 'connected' ? t('tv.devices.connected') : state?.status === 'connecting' ? t('tv.devices.connecting') : (state?.error ?? t('tv.devices.notConnected'))
        return (
          <TvRow
            key={o.id}
            kind="button"
            label={outputName(o.config)}
            sub={status}
            action={
              <>
                <RefreshCw />
                {t('tv.devices.reconnect')}
              </>
            }
            onPress={() => reconnect(o.id)}
          />
        )
      })}
    </TvSheet>
  )
}

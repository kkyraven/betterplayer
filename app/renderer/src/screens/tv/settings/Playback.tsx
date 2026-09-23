import { HWDECS, SUBTITLE_COLOURS, SUBTITLE_COLOUR_LABELS, SUBTITLE_POSITION_MAX, SUBTITLE_SIZES, SUBTITLE_SIZE_LABELS, SUBTITLE_STYLES, SUBTITLE_STYLE_LABELS, defaultSubtitles, type SubtitleSettings } from '@shared/settings'
import { TvRow } from '@/components/tv/TvRow'
import { engine } from '@/engine/client'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

export function PlaybackGroup() {
  const t = useT()
  const sizeOptions = SUBTITLE_SIZES.map((v) => ({ value: v, label: t(SUBTITLE_SIZE_LABELS[v]) }))
  const colourOptions = SUBTITLE_COLOURS.map((v) => ({ value: v, label: t(SUBTITLE_COLOUR_LABELS[v]) }))
  const styleOptions = SUBTITLE_STYLES.map((v) => ({ value: v, label: t(SUBTITLE_STYLE_LABELS[v]) }))
  const subtitles = useSettings((s) => s.settings?.subtitles) ?? defaultSubtitles()
  const update = useSettings((s) => s.update)
  const patch = (change: Partial<SubtitleSettings>) => void update((s) => ({ ...s, subtitles: { ...s.subtitles, ...change } }))
  return (
    <>
      <TvRow kind="switch" label={t('tv.settings.subtitles')} value={subtitles.enabled} onChange={(enabled) => patch({ enabled })} />
      <TvRow kind="options" label={t('tv.playback.size')} options={sizeOptions} value={subtitles.size} onChange={(size) => patch({ size })} disabled={!subtitles.enabled} />
      <TvRow kind="options" label={t('tv.playback.colour')} options={colourOptions} value={subtitles.colour} onChange={(colour) => patch({ colour })} disabled={!subtitles.enabled} />
      <TvRow kind="options" label={t('tv.playback.style')} options={styleOptions} value={subtitles.style} onChange={(style) => patch({ style })} disabled={!subtitles.enabled} />
      <TvRow
        kind="number"
        label={t('tv.playback.height')}
        sub={t('tv.playback.heightSub')}
        value={Math.round(subtitles.position * 100)}
        min={0}
        max={Math.round(SUBTITLE_POSITION_MAX * 100)}
        step={2}
        format={(v) => `${v}%`}
        onChange={(v) => patch({ position: v / 100 })}
        disabled={!subtitles.enabled}
      />
    </>
  )
}

export function HardwareDecodeGroup() {
  const t = useT()
  const hwdecOptions = HWDECS.map((v) => ({ value: v, label: v === 'auto' ? t('common.auto') : t('common.off') }))
  const hwdec = useSettings((s) => s.settings?.playback.hwdec) ?? HWDECS[0]
  const update = useSettings((s) => s.update)
  return <>      <TvRow
        kind="options"
        label={t('tv.playback.hardwareDecode')}
        options={hwdecOptions}
        value={hwdec}
        onChange={(hwdec) => {
          engine.setHwdec(hwdec)
          void update((s) => ({ ...s, playback: { ...s.playback, hwdec } }))
        }}
      />
</>
}

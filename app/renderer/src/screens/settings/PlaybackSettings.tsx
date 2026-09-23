import {
  GAP_SKIPS,
  GAP_SKIP_LABELS,
  HWDECS,
  SUBTITLE_COLOURS,
  SUBTITLE_COLOUR_LABELS,
  SUBTITLE_POSITION_MAX,
  SUBTITLE_SIZES,
  SUBTITLE_SIZE_LABELS,
  SUBTITLE_STYLES,
  SUBTITLE_STYLE_LABELS,
  defaultSubtitles,
  type Hwdec,
  type SubtitleSettings,
} from '@shared/settings'
import type { MessageKey } from '@shared/i18n'
import type { CSSProperties } from 'react'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { engine } from '@/engine/client'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import '@/components/player/Subtitles.css'

const HWDEC_OPTIONS: ReadonlyArray<{ value: Hwdec; label: MessageKey }> = [
  { value: 'auto', label: 'common.auto' },
  { value: 'no', label: 'common.off' },
]
const GAP_SKIP_OPTIONS = GAP_SKIPS.map((value) => ({ value, label: GAP_SKIP_LABELS[value] }))
const SIZE_OPTIONS = SUBTITLE_SIZES.map((value) => ({ value, label: SUBTITLE_SIZE_LABELS[value] }))
const COLOUR_OPTIONS = SUBTITLE_COLOURS.map((value) => ({ value, label: SUBTITLE_COLOUR_LABELS[value] }))
const STYLE_OPTIONS = SUBTITLE_STYLES.map((value) => ({ value, label: SUBTITLE_STYLE_LABELS[value] }))

export function HardwareDecodeSettings() {
  const t = useT()
  const hwdec = useSettings((s) => s.settings?.playback.hwdec) ?? HWDECS[0]
  const update = useSettings((s) => s.update)
  return (
    <div className="panel">
      {' '}
      <div className="prow">
        <span>
          <div className="lbl">{t('settings.video.hardwareDecode')}</div>
          <div className="sub">{t('settings.video.hardwareDecodeHint')}</div>
        </span>
        <span className="spacer" />
        <Segmented
          options={HWDEC_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          value={hwdec}
          onChange={(hwdec) => {
            engine.setHwdec(hwdec)
            void update((s) => ({ ...s, playback: { ...s.playback, hwdec } }))
          }}
          label={t('settings.video.hardwareDecode')}
        />
      </div>
    </div>
  )
}
export function PlaybackSettings() {
  const t = useT()
  const gapSkip = useSettings((s) => s.settings?.playback.gapSkip) ?? 'off'
  const update = useSettings((s) => s.update)
  return (
    <div className="panel">
      {' '}
      <div className="prow">
        <span>
          <div className="lbl">{t('settings.playback.gapSkip')}</div>
          <div className="sub">{t('settings.playback.gapSkipHint')}</div>
        </span>
        <span className="spacer" />
        <Segmented
          options={GAP_SKIP_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          value={gapSkip}
          onChange={(gapSkip) => void update((s) => ({ ...s, playback: { ...s.playback, gapSkip } }))}
          label={t('settings.playback.gapSkip')}
        />
      </div>
    </div>
  )
}
export function SubtitlesSettings() {
  const t = useT()
  const subtitles = useSettings((s) => s.settings?.subtitles) ?? defaultSubtitles()
  const update = useSettings((s) => s.update)
  const updateDebounced = useSettings((s) => s.updateDebounced)
  const patch = (change: Partial<SubtitleSettings>) => void update((s) => ({ ...s, subtitles: { ...s.subtitles, ...change } }))
  return (
    <div className="set-playback">
      {' '}
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.subtitles.show')}</div>
            <div className="sub">{t('settings.subtitles.showHint')}</div>
          </span>
          <span className="spacer" />
          <Switch checked={subtitles.enabled} onCheckedChange={(enabled) => patch({ enabled })} label={t('settings.subtitles.show')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.subtitles.size')}</span>
          <span className="spacer" />
          <Segmented options={SIZE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={subtitles.size} onChange={(size) => patch({ size })} label={t('settings.subtitles.size')} disabled={!subtitles.enabled} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.subtitles.colour')}</span>
          <span className="spacer" />
          <Segmented options={COLOUR_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={subtitles.colour} onChange={(colour) => patch({ colour })} label={t('settings.subtitles.colour')} disabled={!subtitles.enabled} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.subtitles.style')}</span>
          <span className="spacer" />
          <Segmented options={STYLE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={subtitles.style} onChange={(style) => patch({ style })} label={t('settings.subtitles.style')} disabled={!subtitles.enabled} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.subtitles.height')}</span>
          <span className="spacer" />
          <span className="sl">
            <Slider
              value={[Math.round(subtitles.position * 100)]}
              min={0}
              max={Math.round(SUBTITLE_POSITION_MAX * 100)}
              label={t('settings.subtitles.height')}
              disabled={!subtitles.enabled}
              onValueChange={([v]) => updateDebounced((s) => ({ ...s, subtitles: { ...s.subtitles, position: (v ?? 0) / 100 } }))}
            />
          </span>
          <span className="val">{Math.round(subtitles.position * 100)}%</span>
        </div>
        <div className="preview" aria-hidden="true">
          <div
            className="captions"
            data-size={subtitles.size}
            data-colour={subtitles.colour}
            data-style={subtitles.style}
            style={{ '--captions-bottom': `${subtitles.position * 100}%`, opacity: subtitles.enabled ? 1 : 0.35 } as CSSProperties}
          >
            <span>{t('settings.subtitles.preview')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

import {
  DLSS_BUFFER_MAX,
  DLSS_BUFFER_MIN,
  DLSS_FACTORS,
  DLSS_FACTOR_LABELS,
  DLSS_GUIDES,
  DLSS_GUIDE_LABELS,
  DLSS_INPUT_HEIGHTS,
  DLSS_MODEL_PRESETS,
  DLSS_MODEL_PRESET_LABELS,
  DLSS_NR_PRESETS,
  DLSS_NR_PRESET_LABELS,
  DLSS_NR_STYLES,
  DLSS_NR_STYLE_LABELS,
  DLSS_RATES,
  DLSS_RATE_LABELS,
  DLSS_SKIN_MIN,
  DLSS_STRENGTH_MAX,
  DLSS_STRENGTH_MIN,
  DLSS_STRENGTH_STEP,
  FRAME_GEN_LABELS,
  FRAME_GEN_TARGETS,
  UPSCALERS,
  UPSCALER_LABELS,
  defaultDlss,
  defaultUpscaling,
  type DlssSettings,
} from '@shared/settings'
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { SUBSCRIBE_URL } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { Prompt } from '@/components/ui/Prompt'
import { Select } from '@/components/ui/Select'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { enhanceCapabilities as caps } from '@/engine/client'
import { electron } from '@/node'
import { isFree, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { canCompare, useCompare } from '@/state/compare'
import { usePlayer } from '@/state/player'
import { SettingsAdvanced } from './SettingsSection'
import { HardwareDecodeSettings } from './PlaybackSettings'
import { useSettings } from '@/state/settings'

const FRAME_GEN_OPTIONS = FRAME_GEN_TARGETS.map((value) => ({ value, label: FRAME_GEN_LABELS[value] }))
const NR_PRESET_OPTIONS = DLSS_NR_PRESETS.map((value) => ({ value, label: DLSS_NR_PRESET_LABELS[value] }))
const NR_STYLE_OPTIONS = DLSS_NR_STYLES.map((value) => ({ value, label: DLSS_NR_STYLE_LABELS[value] }))
const MODEL_PRESET_OPTIONS = DLSS_MODEL_PRESETS.map((value) => ({ value, label: DLSS_MODEL_PRESET_LABELS[value] }))
const RATE_OPTIONS = DLSS_RATES.map((value) => ({ value, label: DLSS_RATE_LABELS[value] }))
const GUIDE_OPTIONS = DLSS_GUIDES.map((value) => ({ value, label: DLSS_GUIDE_LABELS[value] }))
const FACTOR_OPTIONS = DLSS_FACTORS.map((f) => ({ value: String(f), label: DLSS_FACTOR_LABELS[f] }))
const HEIGHT_OPTIONS = DLSS_INPUT_HEIGHTS.map((h) => ({ value: String(h), label: h === 0 ? ('common.auto' as const) : h === 2160 ? '4K' : h === 1440 ? '2K' : `${h}p` }))

const HUNDRED = 100
const strength = (v: number) => v.toFixed(2)

export function UpscalingSettings() {
  const t = useT()
  const upscaling = useSettings((s) => s.settings?.upscaling) ?? defaultUpscaling()
  const hwdec = useSettings((s) => s.settings?.playback.hwdec ?? 'auto')
  const setUpscaling = usePlayer((s) => s.setUpscaling)
  const upscalerOptions = UPSCALERS.filter((value) => value !== 'apple' || process.platform === 'darwin').map((value) => ({
    value,
    label: t(UPSCALER_LABELS[value]),
    disabled: (value === 'rtx' && !caps.vsr) || (value === 'apple' && !caps.appleVsr) || (value === 'dlss' && !caps.dlss),
    title: value === 'rtx' ? caps.vsrReason : value === 'apple' ? caps.appleVsrReason : value === 'dlss' ? caps.dlssReason : undefined,
  }))
  const compareLeft = useCompare((s) => s.left)
  const start = useCompare((s) => s.start)
  const comparable = usePlayer((s) => canCompare() && s.snapshot.loaded)
  const left = compareLeft === upscaling.upscaler ? (upscaling.upscaler === 'off' ? 'sharp' : 'off') : compareLeft
  const leftOptions = upscalerOptions.map((o) => (o.value === upscaling.upscaler ? { ...o, disabled: true, title: undefined } : o))
  return (
    <div className="set-upscaling">
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.upscaling')}</div>
            {caps.vsrReason && <div className="sub">{t('settings.video.rtxReason', { reason: caps.vsrReason })}</div>}
            {caps.appleVsrReason && process.platform === 'darwin' && <div className="sub">{t('settings.video.appleReason', { reason: caps.appleVsrReason })}</div>}
            {caps.dlssReason && <div className="sub">{t('settings.video.dlssReason', { reason: caps.dlssReason })}</div>}
          </span>
          <span className="spacer" />
          <Select options={upscalerOptions} value={upscaling.upscaler} onChange={(upscaler) => setUpscaling({ upscaler })} label={t('settings.video.upscaling')} />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.frameGeneration')}</div>
            {caps.frameGenReason && <div className="sub">{caps.frameGenReason}</div>}
          </span>
          <span className="spacer" />
          <Segmented
            options={FRAME_GEN_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={upscaling.frameGen}
            onChange={(frameGen) => setUpscaling({ frameGen })}
            label={t('settings.video.frameGeneration')}
            disabled={!caps.frameGen}
          />
        </div>
      </div>
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.compareWith')}</div>
            <div className="sub">{comparable ? t('settings.video.compareHint', { upscaler: t(UPSCALER_LABELS[upscaling.upscaler]) }) : t('settings.video.compareNoVideo')}</div>
          </span>
          <span className="spacer" />
          <Select options={leftOptions} value={left} onChange={(value) => useCompare.getState().setLeft(value)} label={t('settings.video.compareWith')} />
          <Button
            variant="primary"
            disabled={!comparable}
            onClick={() => {
              useCompare.getState().setLeft(left)
              start()
            }}
          >
            {t('settings.video.compare')}
          </Button>
        </div>
      </div>
      <SettingsAdvanced page="video" custom={JSON.stringify(upscaling.dlss ?? defaultDlss()) !== JSON.stringify(defaultDlss()) || hwdec !== 'auto'}>
        <HardwareDecodeSettings />
        <div data-setting="dlss" tabIndex={-1} aria-label="DLSS 5">
          {upscaling.upscaler === 'dlss' ? <DlssRows dlss={upscaling.dlss ?? defaultDlss()} /> : <p className="sub">{t('settings.video.dlssReason', { reason: caps.dlssReason || t('settings.video.dlssNotSelected') })}</p>}
        </div>
      </SettingsAdvanced>
    </div>
  )
}

function DlssRows({ dlss: saved }: { dlss: DlssSettings }) {
  const t = useT()
  const setDlss = usePlayer((s) => s.setDlss)
  const locked = useAccount(isFree)
  const [asking, setAsking] = useState(false)
  const dlss = locked ? defaultDlss() : saved
  const eyebrow = (text: string) => (
    <h3 className="eyebrow">
      {text}
      {locked && <Lock aria-label={t('common.supporterOnly')} />}
    </h3>
  )
  const strengthRow = (label: string, hint: string, key: 'intensity' | 'localTone' | 'localStructure' | 'skinStructure', min: number) => (
    <div className="prow">
      <span>
        <div className="lbl">{label}</div>
        <div className="sub">{hint}</div>
      </span>
      <span className="spacer" />
      <span className="sl">
        <Slider
          value={[Math.round(dlss[key] * HUNDRED)]}
          min={min * HUNDRED}
          max={DLSS_STRENGTH_MAX * HUNDRED}
          step={DLSS_STRENGTH_STEP * HUNDRED}
          label={label}
          onValueChange={([v]) => setDlss({ [key]: (v ?? 0) / HUNDRED })}
        />
      </span>
      <span className="val">{strength(dlss[key])}</span>
    </div>
  )
  return (
    <div className="dlss-rows">
      {locked && <Button onClick={() => setAsking(true)}>{t('common.supporterOnly')}</Button>}
      {eyebrow(t('settings.video.neuralRendering'))}
      <div className="panel" inert={locked}>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.preset')}</div>
            <div className="sub">{t('settings.video.presetHint')}</div>
          </span>
          <span className="spacer" />
          <Select options={NR_PRESET_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={dlss.nrPreset} onChange={(nrPreset) => setDlss({ nrPreset })} label={t('settings.video.preset')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('settings.video.style')}</span>
          <span className="spacer" />
          <Segmented options={NR_STYLE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={dlss.nrStyle} onChange={(nrStyle) => setDlss({ nrStyle })} label={t('settings.video.style')} />
        </div>
        {strengthRow(t('settings.video.intensity'), t('settings.video.intensityHint'), 'intensity', DLSS_STRENGTH_MIN)}
        {strengthRow(t('settings.video.localTone'), t('settings.video.localToneHint'), 'localTone', DLSS_STRENGTH_MIN)}
        {strengthRow(t('settings.video.localStructure'), t('settings.video.localStructureHint'), 'localStructure', DLSS_STRENGTH_MIN)}
        {strengthRow(t('settings.video.skinStructure'), t('settings.video.skinStructureHint'), 'skinStructure', DLSS_SKIN_MIN)}
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.autoMask')}</div>
            <div className="sub">{t('settings.video.autoMaskHint')}</div>
          </span>
          <span className="spacer" />
          <Switch checked={dlss.autoMask} onCheckedChange={(autoMask) => setDlss({ autoMask })} label={t('settings.video.autoMask')} />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.modelPreset')}</div>
            <div className="sub">{t('settings.video.modelPresetHint')}</div>
          </span>
          <span className="spacer" />
          <Select options={MODEL_PRESET_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={dlss.modelPreset} onChange={(modelPreset) => setDlss({ modelPreset })} label={t('settings.video.modelPreset')} />
        </div>
      </div>
      {eyebrow(t('settings.video.processing'))}
      <div className="panel" inert={locked}>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.scalingMode')}</div>
            <div className="sub">{t('settings.video.scalingModeHint')}</div>
          </span>
          <span className="spacer" />
          <Select
            options={FACTOR_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={String(dlss.factor)}
            onChange={(v) => setDlss({ factor: DLSS_FACTORS.find((f) => String(f) === v) ?? dlss.factor })}
            label={t('settings.video.scalingMode')}
          />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.processingHeight')}</div>
            <div className="sub">{t('settings.video.processingHeightHint')}</div>
          </span>
          <span className="spacer" />
          <Select
            options={HEIGHT_OPTIONS.map((o) => ({ ...o, label: o.label === 'common.auto' ? t(o.label) : o.label }))}
            value={String(dlss.inputHeight)}
            onChange={(v) => setDlss({ inputHeight: DLSS_INPUT_HEIGHTS.find((h) => String(h) === v) ?? dlss.inputHeight })}
            label={t('settings.video.processingHeight')}
          />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.frameRate')}</div>
            <div className="sub">{t('settings.video.frameRateHint')}</div>
          </span>
          <span className="spacer" />
          <Segmented options={RATE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={dlss.rate} onChange={(rate) => setDlss({ rate })} label={t('settings.video.frameRate')} disabled />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.motionGuides')}</div>
            <div className="sub">{t('settings.video.motionGuidesHint')}</div>
          </span>
          <span className="spacer" />
          <Segmented options={GUIDE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={dlss.guide} onChange={(guide) => setDlss({ guide })} label={t('settings.video.motionGuides')} disabled />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.video.playbackBuffer')}</div>
            <div className="sub">{t('settings.video.playbackBufferHint')}</div>
          </span>
          <span className="spacer" />
          <span className="sl">
            <Slider
              value={[dlss.bufferSeconds]}
              min={DLSS_BUFFER_MIN}
              max={DLSS_BUFFER_MAX}
              step={1}
              label={t('settings.video.playbackBuffer')}
              onValueChange={([v]) => setDlss({ bufferSeconds: v ?? DLSS_BUFFER_MIN })}
              disabled
            />
          </span>
          <span className="val">{dlss.bufferSeconds} s</span>
        </div>
      </div>
      <Prompt
        open={asking}
        onOpenChange={setAsking}
        title="DLSS 5"
        body={t('settings.video.dlssPromptBody')}
        cancelLabel={t('common.close')}
        confirmLabel={t('common.upgrade')}
        onConfirm={() => void electron.shell.openExternal(SUBSCRIBE_URL)}
      />
    </div>
  )
}

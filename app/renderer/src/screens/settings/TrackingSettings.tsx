import type { MessageKey } from '@shared/i18n'
import { BEAT_BOUNCE_DEPTH, BEAT_BOUNCE_SPEED, CUT_SENSITIVITIES, defaultTrackingDefaults, paceFromSlider, paceToSlider, type CutSensitivity } from '@shared/tracking'
import { AxesTable } from '@/components/tracking/AxesTable'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { SettingsAdvanced, SettingsLink } from './SettingsSection'
import { useTracking } from '@/state/tracking'

const REGION_OPTIONS: ReadonlyArray<{ value: 'auto' | 'centre'; label: MessageKey }> = [
  { value: 'auto', label: 'common.auto' },
  { value: 'centre', label: 'settings.tracking.centre' },
]

const CUT_LABEL: Record<CutSensitivity, MessageKey> = { low: 'settings.tracking.cut.low', normal: 'settings.tracking.cut.normal', high: 'settings.tracking.cut.high' }

export function TrackingSettings() {
  const t = useT()
  const tracking = useSettings((s) => s.settings?.tracking) ?? defaultTrackingDefaults()
  const ready = useTracking((s) => s.present.detector)
  const defaults = defaultTrackingDefaults()
  const custom = ['detectEveryMs', 'regionPadding', 'showBox', 'cutSensitivity', 'easeMs', 'clampJumps', 'generateForScripted', 'axes'].some(
    (key) => JSON.stringify(tracking[key as keyof typeof tracking]) !== JSON.stringify(defaults[key as keyof typeof defaults]),
  )
  const updateDebounced = useSettings((s) => s.updateDebounced)
  const update = useSettings((s) => s.update)
  const regionOptions = REGION_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))
  const cutOptions = CUT_SENSITIVITIES.map((value) => ({ value, label: t(CUT_LABEL[value]) }))
  return (
    <div className="set-tracking">
      <p className="sub">{t('settings.tracking.intro')}</p>
      <div className="panel">
        <div className="prow">
          <TooltipGroup data-tooltip={t('settings.tracking.paceStartHint')}>
            <div className="lbl">{t('settings.tracking.paceStart')}</div>
            <div className="sub">{t('settings.tracking.paceStartSub')}</div>
          </TooltipGroup>
          <span className="spacer" />
          <div className="sl">
            <Slider
              value={[paceToSlider(tracking.defaultPace)]}
              min={0}
              max={100}
              step={5}
              label={t('settings.tracking.paceStart')}
              onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, defaultPace: paceFromSlider(v ?? 50) } }))}
            />
          </div>
          <span className="val">{paceToSlider(tracking.defaultPace)}%</span>
        </div>
        <div className="prow">
          <TooltipGroup data-tooltip={t('settings.tracking.motionDefaultHint')}>
            <div className="lbl">{t('settings.tracking.motionDefault')}</div>
            <div className="sub">{t('settings.tracking.motionDefaultSub')}</div>
          </TooltipGroup>
          <span className="spacer" />
          <Switch
            checked={tracking.motionDefault}
            onCheckedChange={(motionDefault) => void update((s) => ({ ...s, tracking: { ...s.tracking, motionDefault } }))}
            label={t('settings.tracking.motionDefault')}
          />
        </div>
      </div>
      <div className="panel">
        {' '}
        <div className="prow">
          <TooltipGroup data-tooltip={t('settings.tracking.regionStartHint')}>
            <div className="lbl">{t('settings.tracking.regionStart')}</div>
          </TooltipGroup>
          <span className="spacer" />
          <Segmented
            options={regionOptions}
            value={tracking.regionSource}
            onChange={(regionSource) => void update((s) => ({ ...s, tracking: { ...s.tracking, regionSource } }))}
            label={t('settings.tracking.regionStart')}
          />
        </div>
      </div>
      <div className="panel">
        <div className="prow">
          <TooltipGroup data-tooltip={t('settings.tracking.sensitivityHint')}>
            <div className="lbl">{t('settings.tracking.sensitivity')}</div>
          </TooltipGroup>
          <span className="spacer" />
          <div className="sl">
            <Slider
              value={[tracking.sensitivity * 10]}
              min={2}
              max={30}
              label={t('settings.tracking.sensitivity')}
              onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, sensitivity: (v ?? 10) / 10 } }))}
            />
          </div>
          <span className="val">{tracking.sensitivity.toFixed(1)}</span>
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.tracking.flourishes')}</div>
            <div className="sub">{t('settings.tracking.flourishesSub')}</div>
          </span>
          <span className="spacer" />
          <Switch checked={tracking.flourishes} onCheckedChange={(flourishes) => void update((s) => ({ ...s, tracking: { ...s.tracking, flourishes } }))} label={t('settings.tracking.flourishes')} />
        </div>
      </div>
      <h3 className="eyebrow">{t('settings.tracking.beat')}</h3>
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.tracking.bottomBounce')}</div>
          </span>
          <span className="spacer" />
          <Switch
            checked={tracking.beatBounce}
            onCheckedChange={(beatBounce) => void update((s) => ({ ...s, tracking: { ...s.tracking, beatBounce } }))}
            label={t('settings.tracking.bottomBounce')}
          />
        </div>
        <div className="prow">
          <div className="lbl">{t('settings.tracking.bounceDepth')}</div>
          <span className="spacer" />
          <div className="sl">
            <Slider
              value={[tracking.beatBounceDepth * 100]}
              min={BEAT_BOUNCE_DEPTH.min * 100}
              max={BEAT_BOUNCE_DEPTH.max * 100}
              step={1}
              disabled={!tracking.beatBounce}
              label={t('settings.tracking.bounceDepth')}
              onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, beatBounceDepth: (v ?? BEAT_BOUNCE_DEPTH.default * 100) / 100 } }))}
            />
          </div>
          <span className="val">{Math.round(tracking.beatBounceDepth * 100)}%</span>
        </div>
        <div className="prow">
          <div className="lbl">{t('settings.tracking.bounceSpeed')}</div>
          <span className="spacer" />
          <div className="sl">
            <Slider
              value={[tracking.beatBounceSpeed]}
              min={BEAT_BOUNCE_SPEED.min}
              max={BEAT_BOUNCE_SPEED.max}
              step={0.25}
              disabled={!tracking.beatBounce}
              label={t('settings.tracking.bounceSpeed')}
              onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, beatBounceSpeed: v ?? BEAT_BOUNCE_SPEED.default } }))}
            />
          </div>
          <span className="val">{Number(tracking.beatBounceSpeed.toFixed(2))}×</span>
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.tracking.depthByVolume')}</div>
          </span>
          <span className="spacer" />
          <Switch
            checked={tracking.beatVolumeDepth}
            onCheckedChange={(beatVolumeDepth) => void update((s) => ({ ...s, tracking: { ...s.tracking, beatVolumeDepth } }))}
            label={t('settings.tracking.depthByVolume')}
          />
        </div>
      </div>
      <SettingsLink page="models" detail={ready ? t('settings.tracking.modelsReady') : t('settings.tracking.noRegionModel')} />
      <SettingsAdvanced page="tracking" custom={custom}>
        <h3 className="eyebrow">{t('settings.tracking.region')}</h3>
        <div className="panel">
          <div className="prow">
            <TooltipGroup data-tooltip={t('settings.tracking.redetectEveryHint')}>
              <div className="lbl">{t('settings.tracking.redetectEvery')}</div>
            </TooltipGroup>
            <span className="spacer" />
            <div className="sl">
              <Slider
                value={[tracking.detectEveryMs]}
                min={300}
                max={2000}
                step={100}
                label={t('settings.tracking.redetectEvery')}
                onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, detectEveryMs: v ?? 700 } }))}
              />
            </div>
            <span className="val">{t('common.secondsShort', { value: (tracking.detectEveryMs / 1000).toFixed(1) })}</span>
          </div>
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.tracking.regionPadding')}</div>
              <div className="sub">{t('settings.tracking.regionPaddingSub')}</div>
            </span>
            <span className="spacer" />
            <div className="sl">
              <Slider
                value={[tracking.regionPadding * 100]}
                min={0}
                max={100}
                step={10}
                label={t('settings.tracking.regionPadding')}
                onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, regionPadding: (v ?? 40) / 100 } }))}
              />
            </div>
            <span className="val">{Math.round(tracking.regionPadding * 100)}%</span>
          </div>
          <div className="prow">
            <TooltipGroup data-tooltip={t('settings.tracking.showBoxHint')}>
              <div className="lbl">{t('settings.tracking.showBox')}</div>
            </TooltipGroup>
            <span className="spacer" />
            <Switch
              checked={tracking.showBox}
              onCheckedChange={(showBox) => void update((s) => ({ ...s, tracking: { ...s.tracking, showBox } }))}
              label={t('settings.tracking.showBox')}
            />
          </div>
        </div>
        <h3 className="eyebrow">{t('settings.tracking.cuts')}</h3>
        <div className="panel">
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.tracking.cutSensitivity')}</div>
              <div className="sub">{t('settings.tracking.cutSensitivitySub')}</div>
            </span>
            <span className="spacer" />
            <Segmented
              options={cutOptions}
              value={tracking.cutSensitivity}
              onChange={(cutSensitivity) => void update((s) => ({ ...s, tracking: { ...s.tracking, cutSensitivity } }))}
              label={t('settings.tracking.cutSensitivity')}
            />
          </div>
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.tracking.easeAfterCut')}</div>
              <div className="sub">{t('settings.tracking.easeAfterCutSub')}</div>
            </span>
            <span className="spacer" />
            <div className="sl">
              <Slider
                value={[tracking.easeMs]}
                min={0}
                max={1000}
                step={50}
                label={t('settings.tracking.easeAfterCut')}
                onValueChange={([v]) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, easeMs: v ?? 250 } }))}
              />
            </div>
            <span className="val">{t('common.millisShort', { value: tracking.easeMs })}</span>
          </div>
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.tracking.clampJumps')}</div>
              <div className="sub">{t('settings.tracking.clampJumpsSub')}</div>
            </span>
            <span className="spacer" />
            <Switch
              checked={tracking.clampJumps}
              onCheckedChange={(clampJumps) => void update((s) => ({ ...s, tracking: { ...s.tracking, clampJumps } }))}
              label={t('settings.tracking.clampJumps')}
            />
          </div>
        </div>
        <h3 className="eyebrow">{t('settings.tracking.hosted')}</h3>
        <div className="panel">
          <div className="prow">
            <span>
              <div className="lbl">{t('settings.tracking.generateForScripted')}</div>
              <div className="sub">{t('settings.tracking.generateForScriptedSub')}</div>
            </span>
            <span className="spacer" />
            <Switch
              checked={tracking.generateForScripted}
              onCheckedChange={(generateForScripted) => void update((s) => ({ ...s, tracking: { ...s.tracking, generateForScripted } }))}
              label={t('settings.tracking.generateForScripted')}
            />
          </div>
        </div>
        <h3 className="eyebrow">{t('settings.tracking.generatedDefaults')}</h3>
        <div className="panel">
          <div className="axes-wrap" data-setting="generated-motion-defaults" tabIndex={-1} aria-label={t('settings.tracking.generatedDefaults')}>
            <AxesTable
              axes={tracking.axes}
              onChange={(id, patch) => updateDebounced((s) => ({ ...s, tracking: { ...s.tracking, axes: { ...s.tracking.axes, [id]: { ...s.tracking.axes[id], ...patch } } } }))}
            />
          </div>
        </div>
      </SettingsAdvanced>
    </div>
  )
}

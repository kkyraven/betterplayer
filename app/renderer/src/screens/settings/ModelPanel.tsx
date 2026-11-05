import { useEffect, useState } from 'react'
import { isFree, isPremium, useAccount } from '@/state/account'
import { entitledMusicModel, isSupporterModel, type ModelInfo } from '@shared/tracking'
import { VOICE_MODELS } from '@shared/speech'
import { Segmented } from '@/components/ui/Segmented'
import { on } from '@/ipc'
import { models } from '@/engine/client'
import { t, useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useTracking } from '@/state/tracking'
import { SettingsAdvanced } from './SettingsSection'
import { ModelDownloads } from './ModelDownloads'
import { ModelSizeRow } from './ModelSizeRow'
import { PassthroughModelRow } from './PassthroughModelRow'

let cached: readonly ModelInfo[] | null = null
const allModels = (): readonly ModelInfo[] => (cached ??= models())

function statusText(s: { status: string; error?: string | null; provider?: string | null } | null | undefined): string | null {
  if (!s) return null
  if (s.status === 'loading') return t('settings.models.loading')
  if (s.status === 'error') return t('settings.models.failed', { error: s.error ?? '' })
  if (s.status === 'ready') return t('settings.models.ready')
  return null
}

function VoiceModelRows() {
  const [arrived, setArrived] = useState(0)
  useEffect(() => on('models:progress', (p) => {
    if (p.done === p.total && VOICE_MODELS.some((m) => m.id === p.id)) setArrived((n) => n + 1)
  }), [])
  return <ModelDownloads key={arrived} models={VOICE_MODELS} />
}

export function ModelPanel() {
  const t = useT()
  const premium = useAccount(isPremium)
  const free = useAccount(isFree)
  const chosen = useSettings((s) => s.settings?.tracking.models ?? { detector: null, motion: null, music: null })
  const update = useSettings((s) => s.update)
  const refreshModels = useTracking((s) => s.refreshModels)
  const detector = useTracking((s) => s.state?.detector ?? null)
  const motion = useTracking((s) => s.motion)
  const music = useTracking((s) => s.music)
  const present = useTracking((s) => s.present)

  const all = allModels()
  const ai = all.filter((m) => m.kind === 'motion' || m.kind === 'music')
  const musicModels = all.filter((m) => m.kind === 'music')

  const chooseMusic = async (id: string) => {
    await update((s) => ({ ...s, tracking: { ...s.tracking, models: { ...s.tracking.models, music: id } } }))
    await refreshModels()
  }

  const detectorText = free ? t('common.supporterOnly') : statusText(detector)
  return (
    <div data-setting="model-downloads" tabIndex={-1} aria-label={t('settings.page.models')}>
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.models.regionModel')}</div>
            <div className="sub">
              {t('settings.models.regionModelHint')}
              {detectorText ? ` · ${detectorText}` : ''}
            </div>
          </span>
        </div>
        <ModelSizeRow />
      </div>
      <div className="panel">
        {musicModels.length > 1 && (
          <div className="prow">
            <span>
              <div className="lbl" data-setting="music-model" tabIndex={-1}>
                {t('settings.models.aiMusic')}
              </div>
            </span>
            <span className="spacer" />
            <Segmented
              options={musicModels.map((m) => {
                const locked = isSupporterModel(m.id) && !premium
                return { value: m.id, label: locked ? t('settings.models.supporterLabel', { model: m.label }) : m.label, disabled: locked, title: locked ? t('common.supporterOnly') : undefined }
              })}
              value={entitledMusicModel(chosen.music, premium) ?? musicModels[0]?.id ?? ''}
              onChange={(id) => void chooseMusic(id)}
              label={t('settings.models.musicModel')}
            />
          </div>
        )}
        <ModelDownloads
          models={ai}
          onChange={() => void refreshModels()}
          row={(m) => {
            const state = m.kind === 'motion' ? motion : m.id === entitledMusicModel(chosen.music, premium) ? music : null
            const text = isSupporterModel(m.id) && !premium ? t('common.supporterOnly') : statusText(state)
            return (
              <span>
                <div className="lbl">{m.label}</div>
                <div className="sub">
                  {m.sizeMb} MB · {m.version}
                  {text ? ` · ${text}` : ''}
                </div>
              </span>
            )
          }}
        />
      </div>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('vr.voice.title')}</span>
        </div>
        <VoiceModelRows />
      </div>
      <SettingsAdvanced page="models">
        <div className="panel">
          <PassthroughModelRow />
        </div>
        <div className="panel">
          {[
            { label: t('settings.models.regionModel'), state: detector },
            { label: t('settings.models.aiMotion'), state: motion, kind: 'motion' as const },
            { label: t('settings.models.aiMusic'), state: music, kind: 'music' as const },
          ].map(({ label, state, kind }) => (
            <div className="prow" key={label}>
              <span className="lbl">{label}</span>
              <span className="spacer" />
              <span className="sub">
                {state?.status === 'ready'
                  ? t('settings.models.readyOn', { provider: state.provider ?? '' })
                  : (statusText(state) ?? (kind && present[kind] ? t('settings.models.included') : t('common.off')))}
                {state?.status === 'ready' && 'warmupMs' in state ? ` · ${Number(state.warmupMs).toFixed(1)} ms` : ''}
                {state && 'tooSlow' in state && state.tooSlow ? ` · ${t('settings.models.tooSlow')}` : ''}
              </span>
            </div>
          ))}
        </div>
      </SettingsAdvanced>
    </div>
  )
}

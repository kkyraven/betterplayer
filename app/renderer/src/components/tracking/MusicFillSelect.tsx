import { useMemo } from 'react'
import { DEFAULT_MODELS, TRACK_SOURCE_LABEL, defaultTrackingDefaults, entitledMusicModel, isSupporterModel, type MusicFill } from '@shared/tracking'
import { changeRules, musicSource } from '@shared/trackingRules'
import { Select } from '@/components/ui/Select'
import { models } from '@/engine/client'
import { isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

let cachedMusicModels: { id: string; label: string }[] | null = null
export const shippedMusicModels = () => (cachedMusicModels ??= models().filter((m) => m.kind === 'music').map((m) => ({ id: m.id, label: m.label })))

interface Choice {
  value: string
  label: string
  disabled?: boolean
  title?: string
  musicFill: MusicFill
  model?: string
}

interface Props {
  label?: string
  className?: string
}

export function MusicFillSelect({ label, className }: Props) {
  const t = useT()
  const premium = useAccount(isPremium)
  const tracking = useSettings((s) => s.settings?.tracking) ?? defaultTrackingDefaults()
  const update = useSettings((s) => s.update)
  const musicModels = useMemo(() => shippedMusicModels().map((m) => ({ ...m, locked: isSupporterModel(m.id) && !premium })), [premium])
  const music = t(TRACK_SOURCE_LABEL['ai-music'])
  const aiMusic: Choice[] =
    musicModels.length > 1
      ? musicModels.map((m) => ({
          value: `ai-music#${m.id}`,
          label: t(m.locked ? 'tracking.axesTable.musicOptionSupporter' : 'tracking.axesTable.musicOption', { source: music, model: m.label }),
          disabled: m.locked,
          title: m.locked ? t('tracking.supporterOnly') : undefined,
          musicFill: 'ai-music',
          model: m.id,
        }))
      : [{ value: 'ai-music', label: music, musicFill: 'ai-music' }]
  const choices: Choice[] = [
    { value: 'auto', label: t('settings.tracking.autoSource', { source: t(TRACK_SOURCE_LABEL[musicSource({ fill: tracking.fill, musicFill: 'auto' })]) }), musicFill: 'auto' },
    { value: 'same', label: t('settings.tracking.musicSame'), musicFill: 'same' },
    { value: 'beat', label: t(TRACK_SOURCE_LABEL.beat), musicFill: 'beat' },
    ...aiMusic,
  ]
  const playing = entitledMusicModel(tracking.models.music ?? DEFAULT_MODELS.music, premium)
  const value = tracking.musicFill !== 'ai-music' ? tracking.musicFill : (aiMusic.find((c) => c.model === playing) ?? aiMusic[0])?.value ?? 'ai-music'
  const choose = (next: string) => {
    const choice = choices.find((c) => c.value === next)
    if (!choice) return
    void update((s) => {
      const rules = changeRules(s.tracking, { musicFill: choice.musicFill })
      return { ...s, tracking: choice.model ? { ...rules, models: { ...rules.models, music: choice.model } } : rules }
    })
  }
  return <Select options={choices} value={value} onChange={choose} label={label ?? t('settings.tracking.musicFill')} className={className} />
}

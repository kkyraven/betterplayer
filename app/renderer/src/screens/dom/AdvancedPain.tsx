// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PAIN_PHASES, PAIN_SHAPES, defaultPainProfile, painCycle, painFrequency, painHz, painShape, painWave, type PainChannel, type PainProfile } from '@shared/dom-pain'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { engine } from '@/engine/client'
import { useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import './advanced-pain.css'

const letters = ['A', 'B', 'C', 'D']
const rounded = (value: number) => Math.round(value * 1000) / 1000

export function AdvancedPainEditor() {
  const t = useT()
  const pain = useDom((s) => s.advancedPain)
  const running = useDom((s) => s.running)
  const [selected, select] = useState(pain.profiles[0]?.id ?? 'whip')
  const [tab, setTab] = useState<'channels' | 'volume'>('channels')
  const [testing, setTesting] = useState(false)
  const [intensity, setIntensity] = useState(0)
  const [error, setError] = useState(false)
  const profile = pain.profiles.find((p) => p.id === selected) ?? pain.profiles[0]!
  const selectProfile = (id: string) => {
    if (id !== profile.id) {
      engine.stopPain()
      setTesting(false)
    }
    select(id)
  }
  const save = (profiles: PainProfile[]) => { setTesting(false); void useDom.getState().setAdvancedPain({ ...pain, profiles }) }
  const edit = (patch: Partial<PainProfile>) => save(pain.profiles.map((p) => p.id === profile.id ? { ...p, ...patch } : p))
  const editChannel = (index: number, patch: Partial<PainChannel>) => {
    const channels: PainProfile['channels'] = [...profile.channels]
    channels[index] = { ...channels[index]!, ...patch }
    edit({ channels })
  }
  useEffect(() => {
    if (!testing) return
    const timer = window.setInterval(() => {
      const state = engine.painState()
      setTesting(state?.testing === true)
      setIntensity(state?.intensity ?? 0)
    }, 100)
    return () => window.clearInterval(timer)
  }, [testing])
  useEffect(() => () => { if (engine.painState()?.testing) engine.stopPain() }, [])
  const test = () => {
    const accepted = engine.testPain(profile)
    setError(!accepted)
    setIntensity(0)
    setTesting(accepted)
  }
  return <section className="panel advanced-pain">
    <div className="prow">
      <span className="lbl">{t('common.on')}</span><span className="chip">Restim</span><span className="spacer" />
      <Switch checked={pain.enabled} label={t('dom.pain.title')} onCheckedChange={(enabled) => { setTesting(false); void useDom.getState().setAdvancedPain({ ...pain, enabled }) }} />
    </div>
    {pain.enabled && <div className="pain-editor">
      <aside className="pain-profiles" aria-label={t('dom.pain.profiles')}>
        {pain.profiles.map((p) => <button type="button" key={p.id} className={p.id === profile.id ? 'selected' : ''} onClick={() => selectProfile(p.id)}>{p.name}</button>)}
        <Button variant="ghost" onClick={() => {
          const p = { ...defaultPainProfile(), id: crypto.randomUUID(), name: t('dom.pain.newProfile') }
          save([...pain.profiles, p]); select(p.id)
        }}><Plus size={14} />{t('dom.pain.addProfile')}</Button>
      </aside>
      <div className="pain-details">
        <div className="pain-heading">
          <input className="input" aria-label={t('dom.pain.profileName')} key={profile.id + profile.name} defaultValue={profile.name} maxLength={100} onBlur={(e) => { const name = e.currentTarget.value.trim(); if (name) edit({ name }); else e.currentTarget.value = profile.name }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          <Button variant="ghost" icon disabled={pain.profiles.length < 2} aria-label={t('dom.pain.deleteProfile')} onClick={() => save(pain.profiles.filter((p) => p.id !== profile.id))}><Trash2 size={14} /></Button>
        </div>
        <Segmented label={t('dom.pain.profile')} value={tab} onChange={setTab} options={[{ value: 'channels', label: t('dom.pain.channels') }, { value: 'volume', label: t('dom.pain.volumeLimits') }]} />
        {tab === 'channels' ? <div className="pain-channels">
          {profile.channels.map((channel, index) => {
            const letter = letters[index]!
            const wave = Array.from({ length: 201 }, (_, n) => `${n},${36 - painWave(channel, n / 200 * painCycle(channel) * 2) * 32}`).join(' ')
            return <div className="pain-channel" key={letter}>
              <div className="pain-channel-main">
                <strong>{letter}</strong>
                <Select label={`${letter} ${t('dom.pain.shape')}`} value={channel.shape} options={PAIN_SHAPES.map((shape) => ({ value: shape, label: t(`dom.pain.${shape}`) }))} onChange={(shape) => editChannel(index, { ...painShape(shape, painCycle(channel)), intensity: channel.intensity })} />
                <NumberInput value={rounded(channel.intensity * 100)} unit="%" max={100} label={`${letter} ${t('dom.pain.intensity')}`} onChange={(intensity) => editChannel(index, { intensity: intensity / 100 })} />
                <NumberInput value={rounded(painHz(channel))} unit="Hz" min={1 / 60} max={50} digits={5} label={`${letter} Hz`} onChange={(hz) => editChannel(index, painFrequency(channel, hz))} />
              </div>
              <svg className="pain-wave" viewBox="0 0 200 40" role="img" aria-label={`${letter} ${t('dom.pain.shape')}`}><path d="M0 36H200" /><polyline points={wave} /></svg>
              <div className="pain-phases">
                {PAIN_PHASES.map((phase) => <label key={phase}><span>{t(`dom.pain.${phase}`)}</span><NumberInput value={rounded(channel[phase])} unit="ms" max={60000 - painCycle(channel) + channel[phase]} min={Math.max(0, 20 - painCycle(channel) + channel[phase])} digits={5} label={`${letter} ${t(`dom.pain.${phase}`)}`} onChange={(ms) => editChannel(index, { [phase]: ms })} /></label>)}
              </div>
            </div>
          })}
        </div> : <div className="pain-volume">
          <label><span>{t('dom.pain.atZero')}</span><NumberInput value={rounded(profile.volumeMin * 100)} unit="%" max={profile.volumeMax * 100} label={t('dom.pain.atZero')} onChange={(v) => edit({ volumeMin: v / 100 })} /></label>
          <label><span>{t('dom.pain.atTen')}</span><NumberInput value={rounded(profile.volumeMax * 100)} unit="%" min={profile.volumeMin * 100} max={100} label={t('dom.pain.atTen')} onChange={(v) => edit({ volumeMax: v / 100 })} /></label>
          <svg viewBox="0 0 300 100" className="pain-test-curve" role="img" aria-label={t('dom.pain.testRamp')}><path d="M10 90H290" /><polyline points={`10,90 56,${90 - profile.volumeMin * 80} 290,${90 - profile.volumeMax * 80}`} /></svg>
          <span className="sub">{t('dom.pain.testRamp')}</span>
        </div>}
        <div className="pain-test-row">
          {testing ? <><Button onClick={() => { engine.stopPain(); setTesting(false) }}>{t('dom.pain.stopTest')}</Button><span className="val">{intensity.toFixed(1)} / 10</span></> : <Button disabled={running} onClick={test}>{t('dom.pp.test')}</Button>}
          {error && <span role="alert">{t('dom.pain.noRestim')}</span>}
        </div>
      </div>
    </div>}
  </section>
}

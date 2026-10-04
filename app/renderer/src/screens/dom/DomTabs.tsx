// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { Camera, Download, Plus, RefreshCw, Upload, X } from 'lucide-react'
import { useEffect, useState, type ChangeEvent } from 'react'
import { AXES } from '@shared/axes'
import { DOM_LEVEL_MAX, DOM_MEMORY_KINDS, DOM_POINTS, DOM_SPANS, LORA_WEIGHT_MAX, pointAt, spanAt, type DomLora, type DomMemoryKind, type DomPoint, type DomProfile, type DomSpan, type ImageProvider, type ImageSend, type PleasurePain } from '@shared/dom'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { applyLevel, releaseLevel } from '@/dom/level'
import { invoke } from '@/ipc'
import { domErrorText, useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { ChipField } from './ChipField'
import { Portrait } from './Portrait'

type Edit = (dom: DomProfile) => void

const axisLabel = (id: string): MessageKey => AXES.find((a) => a.id === id)?.name ?? 'axis.L0'
const POINT_LABEL: Record<DomPoint, MessageKey> = { C0: 'axis.C0', P0: 'axis.P0', volume: 'axis.EV' }
const pct = (v: number) => Math.round(v * 100)

export function PersonalityTab({ dom, edit }: { dom: DomProfile; edit: Edit }) {
  const t = useT()
  const [busy, setBusy] = useState<'generate' | 'update' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' && edit({ ...dom, portrait: reader.result })
    reader.readAsDataURL(file)
  }
  const generate = async () => {
    setBusy('generate')
    setError(null)
    try {
      const portrait = await invoke('dom:image', dom.id, { pose: 'portrait, looking at viewer', clothing: '', location: '' })
      const current = useDom.getState().doms.find((d) => d.id === dom.id)
      if (current) edit({ ...current, portrait })
    } catch (err) {
      setError(String(err).replace(/^Error.*?: /, ''))
    } finally {
      setBusy(null)
    }
  }
  const update = async () => {
    setBusy('update')
    setError(null)
    try {
      const next = await invoke('dom:refreshPersona', dom.id)
      useDom.setState((s) => ({ doms: s.doms.map((d) => (d.id === next.id ? next : d)) }))
    } catch (err) {
      setError(domErrorText(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="dom-persona">
      <div className="dom-portrait-col">
        <Portrait dom={dom} className="dom-portrait" />
        <label className="btn">
          <Upload />
          {t('dom.portrait.upload')}
          <input type="file" accept="image/*" hidden onChange={upload} />
        </label>
        {dom.images.provider !== 'off' && (
          <Button onClick={() => void generate()} disabled={busy !== null}>
            <Camera />
            {t('dom.portrait.generate')}
          </Button>
        )}
        {error && <span className="dom-err">{error}</span>}
      </div>
      <div className="dom-fields">
        <label className="dom-field">
          <span className="eyebrow">{t('common.name')}</span>
          <input className="input" value={dom.name} maxLength={100} onChange={(e) => edit({ ...dom, name: e.target.value })} />
        </label>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.persona')}</span>
          <textarea className="input dom-textarea" rows={8} value={dom.persona} onChange={(e) => edit({ ...dom, persona: e.target.value })} />
        </label>
        {dom.alPersonaId && (
          <span className="dom-src">
            <Download />
            {t('dom.fromAl')}
            <span className="sep">·</span>
            <button type="button" className="dom-link" disabled={busy !== null} onClick={() => void update()}>{t('dom.update')}</button>
          </span>
        )}
      </div>
    </div>
  )
}

function Pct({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return <NumberInput className="dom-pct" value={pct(value)} onChange={(v) => onChange(v / 100)} min={0} max={100} unit="%" label={label} digits={3} />
}

export function PleasurePainPage() {
  const t = useT()
  const pp = useDom((s) => s.pleasurePain)
  const running = useDom((s) => s.running)
  const [test, setTest] = useState<number | null>(null)
  const shown = test ?? 8
  const setPp = (next: PleasurePain) => void useDom.getState().setPleasurePain(next)
  const setPoint = (k: DomPoint, patch: Partial<PleasurePain['points'][DomPoint]>) => setPp({ ...pp, points: { ...pp.points, [k]: { ...pp.points[k], ...patch } } })
  const setSpan = (k: DomSpan, patch: Partial<PleasurePain['spans'][DomSpan]>) => setPp({ ...pp, spans: { ...pp.spans, [k]: { ...pp.spans[k], ...patch } } })
  useEffect(() => {
    if (test === null || running) return
    applyLevel(pp, test)
  }, [pp, test, running])
  useEffect(() => () => {
    if (!useDom.getState().running) releaseLevel()
  }, [])
  return (
    <>
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('common.on')}</div>
            <div className="sub">{t('dom.pp.hint')}</div>
          </span>
          <span className="spacer" />
          <Switch checked={pp.enabled} onCheckedChange={(enabled) => setPp({ ...pp, enabled })} label={t('dom.tab.pleasurePain')} />
        </div>
      </div>
      <div className="panel dom-pp" inert={!pp.enabled}>
        <table>
          <thead>
            <tr>
              <th>{t('dom.pp.setting')}</th>
              <th>{t('dom.pp.atPleasure')}</th>
              <th>{t('dom.pp.atPain')}</th>
              <th>{t('dom.pp.at', { level: shown })}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {DOM_POINTS.map((k) => {
              const p = pp.points[k]
              const name = t(POINT_LABEL[k])
              return (
                <tr key={k} className={p.on ? undefined : 'off'}>
                  <td>{name}</td>
                  <td><Pct value={p.at0} onChange={(at0) => setPoint(k, { at0 })} label={`${name} ${t('dom.pp.atPleasure')}`} /></td>
                  <td><Pct value={p.at15} onChange={(at15) => setPoint(k, { at15 })} label={`${name} ${t('dom.pp.atPain')}`} /></td>
                  <td className="now">{pct(pointAt(p, shown))}%</td>
                  <td><Switch checked={p.on} onCheckedChange={(on) => setPoint(k, { on })} label={name} /></td>
                </tr>
              )
            })}
            {DOM_SPANS.map((k) => {
              const s = pp.spans[k]
              const name = t('dom.pp.range', { axis: t(axisLabel(k)) })
              const [lo, hi] = spanAt(s, shown)
              const pair = (which: 'at0' | 'at15') => (
                <span className="dom-pair">
                  <Pct value={s[which][0]} onChange={(v) => setSpan(k, { [which]: [Math.min(v, s[which][1]), s[which][1]] })} label={`${name} ${t(which === 'at0' ? 'dom.pp.atPleasure' : 'dom.pp.atPain')} min`} />
                  <Pct value={s[which][1]} onChange={(v) => setSpan(k, { [which]: [s[which][0], Math.max(v, s[which][0])] })} label={`${name} ${t(which === 'at0' ? 'dom.pp.atPleasure' : 'dom.pp.atPain')} max`} />
                </span>
              )
              return (
                <tr key={k} className={s.on ? undefined : 'off'}>
                  <td>{name}</td>
                  <td>{pair('at0')}</td>
                  <td>{pair('at15')}</td>
                  <td className="now">{pct(lo)}–{pct(hi)}</td>
                  <td><Switch checked={s.on} onCheckedChange={(on) => setSpan(k, { on })} label={name} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="dom-test">
          <span className="lbl">{t('dom.pp.test')}</span>
          <Slider value={[shown]} min={0} max={DOM_LEVEL_MAX} step={1} label={t('dom.pp.test')} disabled={running} onValueChange={([v]) => setTest(v ?? 0)} />
          <span className="val">{shown}</span>
        </div>
      </div>
    </>
  )
}

export function ImagesTab({ dom, edit }: { dom: DomProfile; edit: Edit }) {
  const t = useT()
  const img = dom.images
  const [files, setFiles] = useState<{ checkpoints: string[]; loras: string[] } | null>(null)
  const setImg = (patch: Partial<DomProfile['images']>) => edit({ ...dom, images: { ...img, ...patch } })
  const setLora = (i: number, patch: Partial<DomLora>) => setImg({ loras: img.loras.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  useEffect(() => {
    if (img.provider !== 'comfyui') return
    let live = true
    setFiles(null)
    const timer = window.setTimeout(() => void invoke('dom:comfyFiles', img.comfyUrl).then((f) => live && setFiles(f)), 400)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [img.provider, img.comfyUrl])
  const providers: Array<{ value: ImageProvider; label: string }> = [
    { value: 'off', label: t('common.off') },
    { value: 'comfyui', label: 'ComfyUI' },
    { value: 'agenticlover', label: 'Agentic Lover' },
  ]
  const sends: Array<{ value: ImageSend; label: string }> = [
    { value: 'dom', label: t('dom.images.sendDom', { name: dom.name || t('dom.newName') }) },
    { value: 'messages', label: t('dom.images.sendMessages') },
  ]
  const connected = files !== null && files.checkpoints.length > 0
  const options = (list: string[], current: string) => list.concat(list.includes(current) || !current ? [] : [current]).map((c) => ({ value: c, label: c }))
  return (
    <>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('dom.images.madeBy')}</span>
          <span className="spacer" />
          <Segmented options={providers} value={img.provider} onChange={(provider) => setImg({ provider })} label={t('dom.images.madeBy')} />
        </div>
        {img.provider === 'comfyui' && (
          <>
            <div className="prow">
              <span className="lbl">{t('dom.ai.address')}</span>
              <span className="spacer" />
              {files !== null && <span className={connected ? 'dom-status ok' : 'dom-status warn'}><span className="dot" />{connected ? t('dom.images.connected') : t('dom.images.notConnected')}</span>}
              <input className="input mono dom-url" value={img.comfyUrl} onChange={(e) => setImg({ comfyUrl: e.target.value })} spellCheck={false} />
            </div>
            <div className="prow">
              <span className="lbl">{t('dom.images.checkpoint')}</span>
              <span className="spacer" />
              <Select options={options(files?.checkpoints ?? [], img.checkpoint)} value={img.checkpoint} onChange={(checkpoint) => setImg({ checkpoint })} label={t('dom.images.checkpoint')} disabled={!connected} />
            </div>
          </>
        )}
        {img.provider !== 'off' && (
          <>
            <div className="prow">
              <span className="lbl">{t('dom.images.send')}</span>
              <span className="spacer" />
              <Segmented options={sends} value={img.send} onChange={(send) => setImg({ send })} label={t('dom.images.send')} />
            </div>
            {img.send === 'messages' && (
              <div className="prow">
                <span className="lbl">{t('dom.images.every')}</span>
                <span className="spacer" />
                <NumberInput value={img.everySeconds} onChange={(everySeconds) => setImg({ everySeconds: Math.max(10, everySeconds) })} min={10} max={3600} unit="s" label={t('dom.images.every')} digits={4} />
              </div>
            )}
          </>
        )}
      </div>
      {img.provider === 'comfyui' && (
        <div className="dom-field">
          <span className="eyebrow">{t('dom.images.loras')}</span>
          <div className="panel">
            {img.loras.map((l, i) => (
              <div key={i} className="prow dom-lora">
                <Select options={options(files?.loras ?? [], l.name)} value={l.name} onChange={(name) => setLora(i, { name })} label={t('dom.images.loras')} disabled={!connected} />
                <span className="spacer" />
                <NumberInput value={l.weight} onChange={(weight) => setLora(i, { weight })} min={-LORA_WEIGHT_MAX} max={LORA_WEIGHT_MAX} label={t('dom.images.weight')} digits={4} />
                <button type="button" className="dom-x" aria-label={t('common.remove')} onClick={() => setImg({ loras: img.loras.filter((_, j) => j !== i) })}>
                  <X />
                </button>
              </div>
            ))}
            <div className="prow">
              <Button variant="ghost" disabled={!connected || !files?.loras.length} onClick={() => setImg({ loras: [...img.loras, { name: files?.loras[0] ?? '', weight: 0.8 }] })}>
                <Plus />
                {t('common.add')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {img.provider !== 'off' && (
        <>
          <label className="dom-field">
            <span className="eyebrow">{t('dom.images.positive')}</span>
            <textarea className="input dom-textarea" rows={3} value={img.appearance} onChange={(e) => setImg({ appearance: e.target.value })} />
          </label>
          <label className="dom-field">
            <span className="eyebrow">{t('dom.images.negative')}</span>
            <textarea className="input dom-textarea" rows={2} value={img.negative} onChange={(e) => setImg({ negative: e.target.value })} />
          </label>
        </>
      )}
    </>
  )
}

const KIND_LABEL: Record<DomMemoryKind, MessageKey> = { like: 'dom.memory.like', dislike: 'dom.memory.dislike', reaction: 'dom.memory.reaction', limit: 'dom.memory.limit' }

export function MemoryTab({ dom }: { dom: DomProfile }) {
  const t = useT()
  const memories = useDom((s) => s.memories)
  const error = useDom((s) => s.memoriesError)
  const { loadMemories, addMemory, forget, forgetAll } = useDom.getState()
  const [kind, setKind] = useState<DomMemoryKind>('like')
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  useEffect(() => {
    void loadMemories(dom.id)
  }, [dom.id, loadMemories])
  const add = async () => {
    const content = draft.trim()
    if (content.length < 5) return
    try {
      await addMemory(dom.id, kind, content)
      setDraft('')
      setAddError(null)
    } catch (err) {
      setAddError(domErrorText(err))
    }
  }
  return (
    <>
      <h3 className="eyebrow dom-mem-hd">{t('dom.memory.count', { count: memories.length })}</h3>
      <form className="dom-mem-add" onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}>
        <Select options={DOM_MEMORY_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))} value={kind} onChange={setKind} label={t('dom.memory.kind')} />
        <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t('dom.tab.memory')} />
        <Button type="submit" disabled={draft.trim().length < 5}>{t('common.add')}</Button>
      </form>
      {(error || addError) && <span className="dom-err">{error ?? addError}</span>}
      {memories.length > 0 && (
        <div className="panel dom-mem">
          {memories.map((m) => (
            <div key={m.id} className="prow">
              <span className={`dom-kind ${m.kind}`}>{t(KIND_LABEL[m.kind])}</span>
              <span className="txt">{m.content}</span>
              <button type="button" className="x" aria-label={t('common.remove')} onClick={() => void forget(dom.id, m.id)}>
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <span className="dom-src">
        {dom.alPersonaId && (
          <>
            <RefreshCw />
            {t('dom.memory.synced')}
            <span className="sep">·</span>
          </>
        )}
        <button type="button" className="dom-link" disabled={memories.length === 0} onClick={() => setConfirm(true)}>{t('dom.memory.forgetAll')}</button>
      </span>
      <Prompt open={confirm} onOpenChange={setConfirm} title={t('dom.memory.forgetAll')} confirmLabel={t('dom.memory.forgetAll')} danger onConfirm={() => void forgetAll(dom.id)} />
    </>
  )
}

export function YouPage() {
  const t = useT()
  const you = useDom((s) => s.you)
  const setYou = useDom((s) => s.setYou)
  return (
    <div className="dom-you">
      <div className="dom-you-grid">
        <label className="dom-field">
          <span className="eyebrow">{t('common.name')}</span>
          <input className="input" value={you.name} maxLength={100} onChange={(e) => void setYou({ ...you, name: e.target.value })} />
        </label>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.you.pronouns')}</span>
          <input className="input" value={you.pronouns} maxLength={100} onChange={(e) => void setYou({ ...you, pronouns: e.target.value })} />
        </label>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.you.genitals')}</span>
          <input className="input" value={you.genitals} maxLength={100} onChange={(e) => void setYou({ ...you, genitals: e.target.value })} />
        </label>
      </div>
      <div className="dom-field">
        <span className="eyebrow">{t('dom.you.petNames')}</span>
        <ChipField values={you.petNames} onChange={(petNames) => void setYou({ ...you, petNames })} label={t('dom.you.petNames')} />
      </div>
      <div className="dom-field">
        <span className="eyebrow">{t('dom.you.kinks')}</span>
        <ChipField values={you.kinks} onChange={(kinks) => void setYou({ ...you, kinks })} label={t('dom.you.kinks')} />
      </div>
      <div className="dom-field">
        <span className="eyebrow">{t('dom.you.limits')}</span>
        <ChipField values={you.limits} onChange={(limits) => void setYou({ ...you, limits })} label={t('dom.you.limits')} />
      </div>
    </div>
  )
}

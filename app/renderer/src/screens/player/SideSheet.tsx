import { ChevronDown, ChevronRight, Minus, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { AXES, AXIS_LABEL, AXIS_NAME, isAxisId, type AxisId } from '@shared/axes'
import { FLAT, LAYOUTS, LAYOUT_LABELS, PROJECTION_KINDS, PROJECTION_LABELS, detectProjection } from '@shared/projection'
import { PARAM_AXES, PARAM_SOURCES, defaultAxisSettings, type AxisSettings, type FrameGenOverride, type ParamAxisId, type ParamSourceKind } from '@shared/settings'
import { DetectionFields } from '@/components/estim/DetectionFields'
import { LiveMarker } from '@/components/player/LiveMarker'
import { Button } from '@/components/ui/Button'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { IconButton } from '@/components/ui/IconButton'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { engine, enhanceCapabilities } from '@/engine/client'
import { fmtSpeed } from '@/lib/format'
import { useT } from '@/state/i18n'
import { hasRestimOutput, outputName, useDevices } from '@/state/devices'
import { effectiveParam } from '@/state/params'
import { useSettings } from '@/state/settings'
import { usePlayer, useScriptedAxes, type SheetTab } from '@/state/player'
import { useUi } from '@/state/ui'
import { QueueSheet } from './QueueSheet'

const TABS: ReadonlyArray<{ value: SheetTab; label: MessageKey }> = [
  { value: 'video', label: 'player.sideSheet.tabs.video' },
  { value: 'device', label: 'player.sideSheet.tabs.device' },
  { value: 'range', label: 'player.sideSheet.tabs.range' },
]

export function SideSheet() {
  const t = useT()
  const tab = usePlayer((s) => s.sheet)
  const setSheet = usePlayer((s) => s.setSheet)
  if (!tab) return null
  if (tab === 'queue') return <QueueSheet />
  return (
    <TooltipGroup as="aside" className="psheet" onPointerDown={(e) => e.stopPropagation()}>
      <div className="hd">
        {tab === 'projection' ? <h2>{t('player.sideSheet.projection')}</h2> : <Segmented options={TABS.map((o) => ({ value: o.value, label: t(o.label) }))} value={tab} onChange={setSheet} label={t('player.sideSheet.settingsTab')} />}
        <IconButton label={t('common.close')} size="sm" onClick={() => setSheet(null)}>
          <X />
        </IconButton>
      </div>
      <div className="body">
        {tab === 'video' && <VideoTab />}
        {tab === 'device' && <DeviceTab />}
        {tab === 'range' && <RangeTab />}
        {tab === 'projection' && <ProjectionTab />}
      </div>
      {tab === 'video' && <VideoFooter />}
    </TooltipGroup>
  )
}

function useAxisSettings(id: AxisId): AxisSettings {
  const video = usePlayer((s) => s.video)
  const global = useSettings((s) => s.settings?.axesDefault[id])
  return video.axes[id] ?? global ?? defaultAxisSettings(id)
}

function VideoTab() {
  const t = useT()
  const offset = usePlayer((s) => s.video.globalOffsetMs)
  const setGlobalOffset = usePlayer((s) => s.setGlobalOffset)
  const [showAll, setShowAll] = useState(false)
  const scripted = new Set(useScriptedAxes())
  const restim = useDevices((s) => hasRestimOutput(s.outputs))
  const paramsOn = useSettings((s) => s.settings?.estim.params) ?? false
  const shown = AXES.filter((a) => scripted.has(a.id))
  const params = restim && paramsOn ? PARAM_AXES.filter((id) => !scripted.has(id)) : []
  const mainParams: ParamAxisId[] = params.filter((id) => id === 'C0' || id === 'P0')
  const rest = AXES.filter((a) => !scripted.has(a.id) && (a.namespace === 'tcode' || restim) && !params.includes(a.id as ParamAxisId))
  const step = (e: React.MouseEvent, sign: number) => setGlobalOffset(offset + sign * (e.shiftKey ? 100 : 10))
  return (
    <>
      <div className="grp">
        <div className="lbl">
          {t('player.sideSheet.offset')}<span className="hint">{offset === 0 ? t('player.sideSheet.hintDefault') : t('player.sideSheet.hintThisVideo')}</span>
        </div>
        <div className="stepper">
          <button type="button" aria-label={t('player.sideSheet.earlier')} onClick={(e) => step(e, -1)}>
            <Minus />
          </button>
          <span>{t('player.sideSheet.offsetValue', { value: `${offset > 0 ? '+' : ''}${offset}` })}</span>
          <button type="button" aria-label={t('player.sideSheet.later')} onClick={(e) => step(e, 1)}>
            <Plus />
          </button>
        </div>
      </div>
      {enhanceCapabilities.frameGen && <FrameGenGroup />}
      <ScriptsGroup />
      {shown.map((a) => (
        <AxisSection key={a.id} id={a.id} name={t(a.name)} />
      ))}
      {mainParams.map((id) => (
        <ParamSection key={id} id={id} />
      ))}
      {rest.length > 0 && (
        <button type="button" className="collapsed" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? <ChevronDown /> : <ChevronRight />}
          {[...rest.map((a) => `${AXIS_LABEL[a.id]} ${t(a.name)}`), ...params.filter((id) => !mainParams.includes(id)).map((id) => `${id} ${t(AXIS_NAME[id])}`)].join(', ')}
        </button>
      )}
      {showAll && (
        <div className="disclosure-content">
          {rest.map((a) => <AxisSection key={a.id} id={a.id} name={t(a.name)} />)}
          {params.filter((id) => !mainParams.includes(id)).map((id) => <ParamSection key={id} id={id} />)}
        </div>
      )}
    </>
  )
}

const FRAME_GEN_OPTIONS: ReadonlyArray<{ value: FrameGenOverride | 'default'; label: MessageKey }> = [
  { value: 'default', label: 'common.default' },
  { value: 'off', label: 'common.off' },
  { value: 'on', label: 'common.on' },
]

function FrameGenGroup() {
  const t = useT()
  const override = usePlayer((s) => s.video.frameGen)
  const setFrameGen = usePlayer((s) => s.setFrameGen)
  return (
    <div className="grp">
      <div className="lbl">
        {t('player.sideSheet.frameGen')}<span className="hint">{override ? t('player.sideSheet.hintThisVideo') : t('player.sideSheet.hintDefault')}</span>
      </div>
      <Segmented options={FRAME_GEN_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} value={override ?? 'default'} onChange={(v) => setFrameGen(v === 'default' ? null : v)} label={t('player.sideSheet.frameGen')} />
    </div>
  )
}

function ScriptsGroup() {
  const t = useT()
  const scripts = usePlayer((s) => s.scripts)
  const selectVariant = usePlayer((s) => s.selectVariant)
  const axes = [...new Set(scripts.map((s) => s.axis))]
  return (
    <div className="grp">
      <div className="lbl">
        {t('player.sideSheet.scripts')}<span className="hint">{axes.length === 0 ? t('player.sideSheet.noneFound') : t('player.sideSheet.axisCount', { count: axes.length })}</span>
      </div>
      {axes.map((axis) => {
        const options = scripts.filter((s) => s.axis === axis)
        const current = options.find((s) => s.selected) ?? options[0]
        if (!current) return null
        return (
          <div key={axis} className="script-row" data-tooltip={current.source}>
            <span className="axis">{isAxisId(axis) ? AXIS_LABEL[axis] : axis}</span>
            {options.length > 1 ? (
              <select className="select name" value={current.variant ?? ''} aria-label={t('player.sideSheet.axisScript', { name: isAxisId(axis) ? t(AXIS_NAME[axis]) : axis })} onChange={(e) => selectVariant(axis as AxisId, e.target.value || null)}>
                {options.map((o) => (
                  <option key={o.variant ?? ''} value={o.variant ?? ''}>
                    {o.variant ?? t('common.default')}
                  </option>
                ))}
              </select>
            ) : (
              <span className="name">{current.source.split(/[\/]/).pop()}</span>
            )}
            <span className="meta">
              {current.actions} · {fmtSpeed(current.averageSpeed)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function AxisSection({ id, name }: { id: AxisId; name: string }) {
  const t = useT()
  const s = useAxisSettings(id)
  const overridden = usePlayer((p) => p.video.axes[id] !== undefined)
  const setAxis = usePlayer((p) => p.setAxis)
  const resetAxis = usePlayer((p) => p.resetAxis)
  const scripts = usePlayer((p) => p.scripts)
  const linkable = id === 'S0' ? [] : scripts.map((x) => x.axis).filter((x) => x !== id)
  return (
    <div className="axset" data-overridden={overridden || undefined}>
      <div className="top">
        <span className="axis">{AXIS_LABEL[id]}</span>
        <span className="name">{name}</span>
        {overridden && (
          <button type="button" className="reset" onClick={() => resetAxis(id)}>
            {t('player.sideSheet.reset')}
          </button>
        )}
        <span className="tog">
          {t('player.sideSheet.invert')} <Switch checked={s.invert} onCheckedChange={(invert) => setAxis(id, { invert })} label={t('player.sideSheet.invertAxis', { name })} />
        </span>
      </div>
      <div className="rng">
        <span className="k">{t('player.sideSheet.range')}</span>
        <div className="track-wrap">
          <LiveMarker axis={id} />
          <Slider value={[Math.round(s.min * 100), Math.round(s.max * 100)]} label={t('player.sideSheet.axisRange', { name })} onValueChange={([min, max]) => setAxis(id, { min: (min ?? 0) / 100, max: (max ?? 100) / 100 })} />
        </div>
        <span className="v">{t('player.sideSheet.rangeValue', { min: Math.round(s.min * 100), max: Math.round(s.max * 100) })}</span>
      </div>
      <div className="rng">
        <span className="k">{t('player.sideSheet.amplitude')}</span>
        <div className="track-wrap">
          <Slider value={[Math.round(s.amplitude * 100)]} max={200} label={t('player.sideSheet.axisAmplitude', { name })} onValueChange={([v]) => setAxis(id, { amplitude: (v ?? 100) / 100 })} />
        </div>
        <span className="v">{Math.round(s.amplitude * 100)}%</span>
      </div>
      {linkable.length > 0 && (
        <div className="rng">
          <span className="k">{t('player.sideSheet.link')}</span>
          <select className="select" value={s.link ?? ''} aria-label={t('player.sideSheet.axisLink', { name })} onChange={(e) => setAxis(id, { link: e.target.value === '' ? undefined : (e.target.value as AxisId) })}>
            <option value="">{t('common.none')}</option>
            {linkable.map((x) => (
              <option key={x} value={x}>
                {isAxisId(x) ? `${AXIS_LABEL[x]} ${t(AXIS_NAME[x])}` : x}
              </option>
            ))}
          </select>
          <span />
        </div>
      )}
    </div>
  )
}

const SOURCE_LABELS: Record<ParamSourceKind, MessageKey> = { restim: 'player.sideSheet.source.restim', fixed: 'player.sideSheet.source.fixed', sweep: 'player.sideSheet.source.sweep', audio: 'player.sideSheet.source.audio', detection: 'player.sideSheet.source.detection' }

function ParamSection({ id }: { id: ParamAxisId }) {
  const t = useT()
  const override = usePlayer((p) => p.video.params?.[id])
  const outputParams = useDevices((s) => s.outputs.find((o) => o.config.profile === 'restim')?.config.params?.[id])
  const setParam = usePlayer((p) => p.setParam)
  const resetParam = usePlayer((p) => p.resetParam)
  const param = override ?? outputParams ?? effectiveParam(id)
  const name = t(AXIS_NAME[id])
  return (
    <div className="axset" data-overridden={override !== undefined || undefined}>
      <div className="top">
        <span className="axis">{AXIS_LABEL[id]}</span>
        <span className="name">{name}</span>
        {override !== undefined && (
          <button type="button" className="reset" onClick={() => resetParam(id)}>
            {t('player.sideSheet.reset')}
          </button>
        )}
      </div>
      <div className="rng">
        <span className="k">{t('player.sideSheet.source')}</span>
        <select className="select" value={param.source} aria-label={t('player.sideSheet.axisSource', { name })} onChange={(e) => setParam(id, { source: e.target.value as ParamSourceKind })}>
          {PARAM_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(SOURCE_LABELS[s])}
            </option>
          ))}
        </select>
        <span />
      </div>
      {param.source === 'fixed' && (
        <div className="rng">
          <span className="k">{t('player.sideSheet.value')}</span>
          <Slider label={t('player.sideSheet.axisValue', { name })} value={[Math.round(param.value * 100)]} onValueChange={([v]) => v !== undefined && setParam(id, { value: v / 100 })} />
          <span className="v">{Math.round(param.value * 100)}%</span>
        </div>
      )}
      {param.source === 'detection' && <DetectionFields id={id} param={param} onChange={(patch) => setParam(id, patch)} />}
    </div>
  )
}

function VideoFooter() {
  const t = useT()
  const overridden = usePlayer((p) => Object.keys(p.video.axes).length > 0 || p.video.globalOffsetMs !== 0 || p.video.params !== undefined)
  const resetAxis = usePlayer((p) => p.resetAxis)
  const resetParam = usePlayer((p) => p.resetParam)
  const setGlobalOffset = usePlayer((p) => p.setGlobalOffset)
  return (
    <div className="ft">
      <span>{overridden ? t('player.sideSheet.savedForVideo') : t('player.sideSheet.usingDefaults')}</span>
      {overridden && (
        <button
          type="button"
          onClick={() => {
            resetAxis()
            setGlobalOffset(0)
            for (const id of PARAM_AXES) resetParam(id)
          }}
        >
          {t('player.sideSheet.resetToDefaults')}
        </button>
      )}
    </div>
  )
}

function DeviceTab() {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  const states = useDevices((s) => s.states)
  const setScreen = useUi((s) => s.setScreen)
  return (
    <>
      {outputs.length === 0 && <p className="muted">{t('player.sideSheet.noDevices')}</p>}
      {outputs.map((o) => {
        const st = states[o.id]
        return (
          <div key={o.id} className="script-row">
            <span className={`dot ${st?.status === 'connected' ? '' : st?.status === 'error' ? 'warn' : 'idle'}`} />
            <span className="name">{st?.device ?? outputName(o.config)}</span>
            <span className="meta">{st?.status === 'error' ? st.error : st?.tcode ?? st?.status}</span>
          </div>
        )
      })}
      <Button onClick={() => setScreen('devices')}>{t('player.sideSheet.openDevices')}</Button>
    </>
  )
}

function RangeTab() {
  const t = useT()
  const scripted = new Set(useScriptedAxes())
  const restim = useDevices((s) => hasRestimOutput(s.outputs))
  const axes = AXES.filter((a) => a.id !== 'S0' && (scripted.has(a.id) || a.kind === 'position' || a.kind === 'rotation' || (restim && a.kind === 'estimPosition')))
  return (
    <>
      <p className="muted">{t('player.sideSheet.rangeHelp')}</p>
      {axes.map((a) => (
        <RangeRow key={a.id} id={a.id} name={t(a.name)} />
      ))}
    </>
  )
}

function RangeRow({ id, name }: { id: AxisId; name: string }) {
  const t = useT()
  const s = useAxisSettings(id)
  const setAxis = usePlayer((p) => p.setAxis)
  const [dragging, setDragging] = useState<[number, number] | null>(null)
  const value = dragging ?? [Math.round(s.min * 100), Math.round(s.max * 100)]
  return (
    <div className="rng" data-live={dragging !== null || undefined}>
      <span className="k">
        <span className="axis">{AXIS_LABEL[id]}</span> {name}
      </span>
      <div className="track-wrap">
        <Slider
          value={value}
          label={t('player.sideSheet.axisRange', { name })}
          onValueChange={([min, max]) => {
            const next: [number, number] = [min ?? 0, max ?? 100]
            const moved = dragging && dragging[0] !== next[0] ? next[0] : next[1]
            engine.setLive(id, moved / 100)
            setDragging(next)
          }}
          onValueCommit={([min, max]) => {
            engine.setLive(id, null)
            setDragging(null)
            setAxis(id, { min: (min ?? 0) / 100, max: (max ?? 100) / 100 })
          }}
        />
      </div>
      <span className="v">{t('player.sideSheet.rangeValue', { min: value[0], max: value[1] })}</span>
    </div>
  )
}

function ProjectionTab() {
  const t = useT()
  const projection = usePlayer((s) => s.projection)
  const overridden = usePlayer((s) => s.video.projection !== undefined)
  const title = usePlayer((s) => s.title)
  const setProjection = usePlayer((s) => s.setProjection)
  const detected = detectProjection(title)
  const kinds = PROJECTION_KINDS.map((k) => ({ value: k, label: t(PROJECTION_LABELS[k]) }))
  const layouts = LAYOUTS.map((l) => ({ value: l, label: t(LAYOUT_LABELS[l]) }))
  return (
    <>
      <div className="grp">
        <div className="lbl">
          {t('player.sideSheet.source')}<span className="hint">{overridden ? t('player.sideSheet.hintThisVideo') : t('player.sideSheet.fromFileName')}</span>
        </div>
        <Segmented options={kinds} value={projection.kind} onChange={(kind) => setProjection({ ...projection, kind, layout: kind === 'flat' ? 'mono' : projection.layout })} label={t('player.sideSheet.projection')} />
      </div>
      {projection.kind !== 'flat' && (
        <div className="grp">
          <div className="lbl">{t('player.sideSheet.eyes')}</div>
          <Segmented options={layouts} value={projection.layout} onChange={(layout) => setProjection({ ...projection, layout })} label={t('player.sideSheet.layout')} />
          {projection.layout !== 'mono' && (
            <div className="tog-row">
              {t('player.sideSheet.swapEyes')} <Switch checked={projection.swapEyes} onCheckedChange={(swapEyes) => setProjection({ ...projection, swapEyes })} label={t('player.sideSheet.swapEyes')} />
            </div>
          )}
        </div>
      )}
      {projection.kind === 'fisheye' && (
        <div className="grp">
          <div className="lbl">
            {t('player.sideSheet.lens')}<span className="hint">{projection.fov}°</span>
          </div>
          <Slider value={[projection.fov]} min={150} max={240} label={t('player.sideSheet.lensCoverage')} onValueChange={([fov]) => setProjection({ ...projection, fov: fov ?? 190 })} />
        </div>
      )}
      {overridden && (
        <Button variant="ghost" onClick={() => setProjection(null)}>
          {t('player.sideSheet.useFileName', { projection: `${t(PROJECTION_LABELS[detected.kind])}${detected.kind !== 'flat' ? ` ${t(LAYOUT_LABELS[detected.layout])}` : ''}` })}
        </Button>
      )}
      {!overridden && projection.kind === 'flat' && detected === FLAT && <p className="muted">{t('player.sideSheet.noVrTag')}</p>}
    </>
  )
}

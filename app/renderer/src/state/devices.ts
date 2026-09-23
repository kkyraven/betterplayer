import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { track } from '@/state/usage'
import type { OutputState, OutputStats, RampConfig } from 'bp-engine'
import { OPENSHOCK_PULSE_MS, type FeatureLevel, type OpenShockTrigger, type OutputConfig, type OutputProfile, type ParamAxisId, type ParamSourceSettings, type RampSettings, type Settings, type VibrationSettings } from '@shared/settings'
import { AXIS_IDS, type AxisId } from '@shared/axes'
import { engine } from '@/engine/client'
import { t } from '@/state/i18n'
import * as live from './live'
import { pushParams } from './params'
import { useSettings } from './settings'
import { isPremium, useAccount } from './account'

export interface ConfiguredOutput {
  id: number
  config: OutputConfig
}

interface DevicesState {
  outputs: ConfiguredOutput[]
  states: Record<number, OutputState>
  selectedId: number | null
  connectSaved: (configs: OutputConfig[]) => void
  add: (config: OutputConfig) => Promise<number>
  remove: (id: number) => Promise<void>
  reconnect: (id: number) => void
  select: (id: number | null) => void
  setProfile: (id: number, profile: OutputProfile) => Promise<void>
  rename: (id: number, name: string) => Promise<void>
  setStrength: (id: number, a: number, b: number) => Promise<void>
  setTrigger: (id: number, trigger: OpenShockTrigger) => Promise<void>
  setVibration: (id: number, vibration: VibrationSettings | null) => Promise<void>
  setDelay: (id: number, ms: number) => void
  setRamp: (id: number, ramp: RampSettings) => Promise<void>
  restartRamp: (id: number) => void
  setParam: (id: number, axis: ParamAxisId, source: ParamSourceSettings) => Promise<void>
  setFeatureAxis: (id: number, feature: number, axis: AxisId | null) => Promise<void>
  setFeatureLevel: (id: number, feature: number, level: FeatureLevel | null) => void
  setStates: (outputs: OutputState[]) => void
}

export function pushStopOnPause(on: boolean) {
  engine.setStopOnPause(on)
}

export function setStopOnPause(on: boolean) {
  pushStopOnPause(on)
  void useSettings.getState().update((s) => ({ ...s, devices: { ...s.devices, stopOnPause: on } }))
}

const rampConfig = (r: RampSettings): RampConfig => ({ enabled: r.enabled, start: r.start, max: r.max, durationMs: r.minutes * 60_000 })

function pushRestim(id: number, config: OutputConfig) {
  if (config.profile !== 'restim' || !config.ramp) return
  engine.setOutputRamp(id, rampConfig(config.ramp))
}

function pushFeatureAxes(id: number, config: OutputConfig) {
  for (const [feature, axis] of Object.entries(config.featureAxes ?? {})) engine.setOutputFeatureAxis(id, Number(feature), axis)
  for (const [feature, level] of Object.entries(config.featureLevels ?? {})) engine.setOutputFeatureLevel(id, Number(feature), level)
}

let lockedId = 0x80000000

function connect(config: OutputConfig): ConfiguredOutput {
  config = { ...config, id: config.id ?? crypto.randomUUID() }
  if (config.kind === 'pishock' && !isPremium(useAccount.getState())) return { id: lockedId++, config }
  const { kind, path, baud, host, port, url, profile, device, address, strengthA, strengthB, key, appKey, hosting, token, shocker, trigger, username, userId, clientId } = config
  const id = engine.connect({ kind, path, baud, host, port, url, profile, name: device, address, strengthA, strengthB, key, appKey, hosting, token, shocker, trigger, username, userId, clientId })
  pushRestim(id, config)
  pushFeatureAxes(id, config)
  if (config.vibration) engine.setOutputVibration(id, config.vibration)
  if (config.delayMs) engine.setOutputDelay(id, config.delayMs)
  return { id, config }
}

export function outputName(config: OutputConfig): string {
  if (config.name) return config.name
  switch (config.kind) {
    case 'serial':
      return config.path?.split(/[\\/]/).pop() ?? t('devices.name.serial')
    case 'udp':
    case 'tcp':
      return `${config.host ?? ''}:${config.port ?? ''}`
    case 'websocket':
      return config.profile === 'restim' ? 'restim' : (config.url ?? 'WebSocket')
    case 'buttplug':
      return 'Intiface'
    case 'ble':
    case 'toy':
      return config.device ?? t('devices.name.bluetooth')
    case 'ossm':
      return config.device ?? 'OSSM'
    case 'coyote':
      return 'Coyote'
    case 'handy':
      return 'Handy'
    case 'howl':
      return 'Howl'
    case 'openshock':
      return 'OpenShock'
    case 'pishock':
      return 'PiShock'
  }
}

export function hasRestimOutput(outputs: ConfiguredOutput[]): boolean {
  return outputs.some((o) => o.config.profile === 'restim')
}

export const useDevices = create<DevicesState>()((set, get) => {
  const saved = (s: Settings): Settings => ({ ...s, devices: { ...s.devices, outputs: get().outputs.map((o) => o.config) } })
  const persist = () => useSettings.getState().update(saved)
  const persistDebounced = () => useSettings.getState().updateDebounced(saved)
  return {
    outputs: [],
    states: {},
    selectedId: null,
    connectSaved: (configs) => {
      engine.setPishockEnabled(isPremium(useAccount.getState()))
      for (const c of configs) track(`device.${c.kind}`)
      const outputs = configs.map(connect)
      set({ outputs, selectedId: outputs[0]?.id ?? null })
      if (configs.some(c => !c.id)) void persist()
      pushParams()
    },
    add: async (config) => {
      if (config.kind === 'pishock' && !isPremium(useAccount.getState())) throw new Error(t('common.supporterOnly'))
      const output = connect(config)
      set((s) => ({ outputs: [...s.outputs, output], selectedId: output.id }))
      pushParams()
      await persist()
      return output.id
    },
    remove: async (id) => {
      engine.disconnect(id)
      set((s) => {
        const outputs = s.outputs.filter((o) => o.id !== id)
        return { outputs, selectedId: s.selectedId === id ? (outputs[0]?.id ?? null) : s.selectedId }
      })
      pushParams()
      await persist()
    },
    reconnect: (id) => {
      const current = get().outputs.find((o) => o.id === id)
      if (!current) return
      engine.disconnect(id)
      const output = connect(current.config)
      set((s) => ({
        outputs: s.outputs.map((o) => (o.id === id ? output : o)),
        selectedId: s.selectedId === id ? output.id : s.selectedId,
      }))
    },
    select: (selectedId) => set({ selectedId }),
    setProfile: async (id, profile) => {
      engine.setOutputProfile(id, profile)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, profile } } : o)) }))
      const output = get().outputs.find((o) => o.id === id)
      if (output) pushRestim(id, output.config)
      pushParams()
      await persist()
    },
    setRamp: async (id, ramp) => {
      engine.setOutputRamp(id, rampConfig(ramp))
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, ramp } } : o)) }))
      await persist()
    },
    restartRamp: (id) => {
      engine.restartOutputRamp(id)
    },
    setParam: async (id, axis, source) => {
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, params: { ...o.config.params, [axis]: source } } } : o)) }))
      pushParams()
      await persist()
    },
    setFeatureAxis: async (id, feature, axis) => {
      engine.setOutputFeatureAxis(id, feature, axis)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, featureAxes: { ...o.config.featureAxes, [feature]: axis } } } : o)) }))
      await persist()
    },
    setFeatureLevel: (id, feature, level) => {
      engine.setOutputFeatureLevel(id, feature, level)
      set((s) => ({
        outputs: s.outputs.map((o) => {
          if (o.id !== id) return o
          const { [feature]: _dropped, ...rest } = o.config.featureLevels ?? {}
          const featureLevels = level ? { ...rest, [feature]: level } : rest
          return { ...o, config: { ...o.config, featureLevels: Object.keys(featureLevels).length > 0 ? featureLevels : undefined } }
        }),
      }))
      persistDebounced()
    },
    setStrength: async (id, a, b) => {
      engine.setCoyoteStrength(id, a, b)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, strengthA: a, strengthB: b } } : o)) }))
      await persist()
    },
    setVibration: async (id, vibration) => {
      engine.setOutputVibration(id, vibration)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, vibration: vibration ?? undefined } } : o)) }))
      await persist()
    },
    setDelay: (id, ms) => {
      engine.setOutputDelay(id, ms)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, delayMs: ms || undefined } } : o)) }))
      persistDebounced()
    },
    setTrigger: async (id, trigger) => {
      engine.setOpenshockTrigger(id, trigger)
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, trigger } } : o)) }))
      await persist()
    },
    rename: async (id, name) => {
      set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, config: { ...o.config, name: name.trim() || undefined } } : o)) }))
      await persist()
    },
    setStates: (outputs) => set({ states: Object.fromEntries(outputs.map((o) => [o.id, o])) }),
  }
})

const AXES_POLL_MS = 100

export function usePlayerAxes(): Partial<Record<AxisId, number>> {
  const [values, setValues] = useState<Partial<Record<AxisId, number>>>({})
  useEffect(() => {
    let last = 0
    const read = (l: live.Live) => {
      const now = performance.now()
      if (now - last < AXES_POLL_MS) return
      last = now
      setValues((prev) => {
        let changed = false
        const next: Partial<Record<AxisId, number>> = {}
        for (const id of AXIS_IDS) {
          const i = live.axisIndex(id)
          if (i < 0) continue
          const v = Math.round((l.axisValues[i] ?? 0) * 100) / 100
          next[id] = v
          if (prev[id] !== v) changed = true
        }
        return changed ? next : prev
      })
    }
    read(live.get())
    return live.subscribe(read)
  }, [])
  return values
}

export function useOutputStats(id: number): OutputStats | null {
  const [stats, setStats] = useState<OutputStats | null>(null)
  useEffect(() => {
    const read = () => setStats(engine.outputStats(id))
    read()
    const timer = window.setInterval(read, 500)
    return () => window.clearInterval(timer)
  }, [id])
  return stats
}

const SWEEP_MS = 3000
const HOSTED_TEST_MS = 5000

export function testMove(output: ConfiguredOutput): Promise<void> {
  const profile = output.config.profile
  if (output.config.kind === 'pishock' && !isPremium(useAccount.getState())) return Promise.resolve()
  if (output.config.kind === 'openshock' || output.config.kind === 'pishock') {
    engine.testOutput(output.id)
    return new Promise((resolve) => window.setTimeout(resolve, OPENSHOCK_PULSE_MS))
  }
  if (engine.testOutput(output.id)) return new Promise((resolve) => window.setTimeout(resolve, output.config.kind === 'toy' ? SWEEP_MS : HOSTED_TEST_MS))
  if (output.config.kind === 'toy') return Promise.resolve()
  const axes: AxisId[] = profile === 'restim' ? ['EA', 'EB'] : ['L0']
  return new Promise((resolve) => {
    const start = performance.now()
    const frame = () => {
      const u = Math.min(1, (performance.now() - start) / SWEEP_MS)
      const theta = u * Math.PI * 2
      if (profile === 'restim') {
        engine.setLive('EA', 0.5 + 0.4 * Math.cos(theta))
        engine.setLive('EB', 0.5 + 0.4 * Math.sin(theta))
      } else engine.setLive('L0', 0.5 - 0.4 * Math.sin(theta))
      if (u < 1) requestAnimationFrame(frame)
      else {
        for (const a of axes) engine.setLive(a, null)
        resolve()
      }
    }
    requestAnimationFrame(frame)
  })
}

useAccount.subscribe((state, previous) => {
  const allowed = isPremium(state)
  if (!engine || allowed === isPremium(previous)) return
  engine.setPishockEnabled(allowed)
  const current = useDevices.getState()
  const outputs = current.outputs.map((output) => output.config.kind === 'pishock' ? connect(output.config) : output)
  const selected = current.outputs.findIndex((o) => o.id === current.selectedId)
  useDevices.setState({ outputs, selectedId: selected < 0 ? null : outputs[selected]?.id ?? null })
})

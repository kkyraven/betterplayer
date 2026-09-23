import { create } from 'zustand'
import type { GenerateState } from 'bp-engine'
import type { ScriptFile } from '@shared/ipc'
import { TRACK_AXES } from '@shared/tracking'
import { useEditor } from './editor'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { t, useI18n } from '@/state/i18n'
import { currentSetup, runGeneration, savedResult, toFiles, toRows, waitForAudio, type RunSetup } from './generated'
import { useRecompute } from './recompute'
import { isUrl, usePlayer } from './player'
import { useTracking } from './tracking'

export type StepId = 'audio' | 'music' | 'model' | 'motion' | 'video' | 'save'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export interface GenerateStep {
  id: StepId
  label: string
  detail: string | null
  status: StepStatus
}

interface ExportTarget {
  path: string
  title: string
  setup: RunSetup | null
  tracking: Pick<ReturnType<typeof useTracking.getState>, 'axes' | 'heroZone'>
}

interface GenerateStore {
  target: ExportTarget | null
  open: boolean
  phase: 'plan' | 'running' | 'done' | 'error'
  steps: GenerateStep[]
  files: string[]
  progress: GenerateState | null
  startedAt: number
  scripts: ScriptFile[] | null
  saved: string[] | null
  error: string | null
  plan: () => Promise<void>
  start: () => Promise<void>
  save: () => Promise<void>
  openInEditor: () => Promise<void>
  cancel: () => void
  close: () => void
}

function plannedFiles(title: string): string[] {
  const axes = useTracking.getState().axes
  return TRACK_AXES.filter((a) => axes[a.id].source !== 'off').map((a) => `${title}${a.suffix ? `.${a.suffix}` : ''}.funscript`)
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useGenerate = create<GenerateStore>()((set, get) => {
  let task = new AbortController()
  let nativeTask: AbortController | null = null
  const mark = (id: StepId, patch: Partial<GenerateStep>) => set({ steps: get().steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const has = (id: StepId) => get().steps.some((s) => s.id === id)
  return {
    target: null,
    open: false,
    phase: 'plan',
    steps: [],
    files: [],
    progress: null,
    startedAt: 0,
    scripts: null,
    saved: null,
    error: null,
    plan: async () => {
      if (get().phase === 'running') return
      task.abort()
      task = new AbortController()
      const { signal } = task
      const tracking = useTracking.getState()
      const player = usePlayer.getState()
      if (!player.path || isUrl(player.path)) return
      const setup = currentSetup()
      const target: ExportTarget = { path: player.path, title: player.title, setup, tracking: { axes: tracking.axes, heroZone: tracking.heroZone } }
      const files = plannedFiles(player.title)
      const saveStep: GenerateStep = { id: 'save', label: t('editor.generate.chooseWhereToSave'), detail: files.join(', '), status: 'pending' }
      const saved = setup ? await savedResult(setup) : null
      if (signal.aborted) return
      if (saved && saved.length > 0) {
        set({ target, open: true, phase: 'plan', steps: [saveStep], files, progress: null, scripts: toFiles(saved), saved: null, error: null })
        return
      }
      const sources = new Set(Object.values(tracking.axes).map((a) => a.source))
      const steps: GenerateStep[] = []
      if (sources.has('beat')) {
        const ready = tracking.beat?.status === 'ready'
        steps.push({ id: 'audio', label: t('editor.generate.analyseAudio'), detail: ready ? t('editor.generate.bpm', { bpm: Math.round(tracking.beat?.bpm ?? 0) }) : t('editor.generate.decodesSoundTrack'), status: ready ? 'done' : 'pending' })
      }
      if (sources.has('ai-music')) {
        const pass = tracking.beat?.model.status
        const ready = pass === 'ready'
        if (!steps.some((s) => s.id === 'audio')) {
          const beatReady = tracking.beat?.status === 'ready'
          steps.push({ id: 'audio', label: t('editor.generate.analyseAudio'), detail: beatReady ? t('editor.generate.bpm', { bpm: Math.round(tracking.beat?.bpm ?? 0) }) : t('editor.generate.decodesSoundTrack'), status: beatReady ? 'done' : 'pending' })
        }
        steps.push({ id: 'music', label: t('editor.generate.runAiMusic'), detail: ready ? null : t('editor.generate.watchesFirst'), status: ready ? 'done' : 'pending' })
      }
      if (sources.has('video') || sources.has('hero') || sources.has('ai-motion')) {
        if (tracking.regionSource === 'auto' && tracking.state?.detector.status === 'ready') steps.push({ id: 'model', label: t('editor.generate.loadDetector'), detail: null, status: 'pending' })
        const motionModel = sources.has('ai-motion') && tracking.motion?.status === 'ready'
        if (motionModel) steps.push({ id: 'motion', label: t('editor.generate.loadAiMotion'), detail: tracking.motion?.provider ?? null, status: 'pending' })
        const parts: string[] = []
        if (sources.has('video') || (sources.has('ai-motion') && !motionModel)) parts.push(t('editor.generate.what.motion'))
        if (motionModel) parts.push(t('editor.generate.what.aiMotion'))
        if (sources.has('hero')) parts.push(t('editor.generate.what.notes'))
        const what = new Intl.ListFormat(useI18n.getState().locale, { type: 'conjunction' }).format(parts)
        const zone = sources.has('hero') && !tracking.heroZone ? `${t('editor.generate.noHeroZone')} ` : ''
        steps.push({ id: 'video', label: t('editor.generate.trackVideo', { what }), detail: `${zone}${t('editor.generate.howLong')}`, status: 'pending' })
      }
      steps.push(saveStep)
      set({ target, open: true, phase: 'plan', steps, files, progress: null, scripts: null, saved: null, error: null })
    },
    start: async () => {
      const { target } = get()
      if (!target || !get().open || get().phase !== 'plan') return
      if (get().scripts) {
        await get().save()
        return
      }
      if (usePlayer.getState().path !== target.path) {
        set({ phase: 'error', error: t('editor.generate.videoChanged') })
        return
      }
      const run = task
      const { signal } = run
      const setup = currentSetup()
      if (setup?.key !== target.setup?.key || setup?.hash !== target.setup?.hash) {
        set({ phase: 'error', error: t('editor.generate.setupChanged') })
        return
      }
      set({ phase: 'running', error: null })
      if (has('audio') && get().steps.find((s) => s.id === 'audio')?.status === 'pending') {
        mark('audio', { status: 'running' })
        try {
          const detail = await waitForAudio(target.path, signal)
          if (signal.aborted) return
          mark('audio', { status: 'done', detail })
        } catch (e) {
          if (signal.aborted) return
          mark('audio', { status: 'failed', detail: message(e) })
        }
      }
      if (signal.aborted) return
      if (usePlayer.getState().path !== target.path) {
        set({ phase: 'error', error: t('editor.generate.videoChanged') })
        return
      }
      const current = currentSetup()
      if (setup?.key !== current?.key || setup?.hash !== current?.hash) {
        set({ phase: 'error', error: t('editor.generate.setupChanged') })
        return
      }
      if (has('model')) mark('model', { status: 'running' })
      else if (has('motion')) mark('motion', { status: 'running' })
      else if (has('video')) mark('video', { status: 'running' })
      set({ startedAt: performance.now() })
      let scripts: Awaited<ReturnType<typeof runGeneration>>
      try {
        nativeTask = run
        scripts = await runGeneration((p) => {
          if (signal.aborted) return
          set({ progress: p })
          if (p.status === 'running' && has('video') && get().steps.find((s) => s.id === 'video')?.status === 'pending') {
            if (has('model')) mark('model', { status: 'done' })
            if (has('motion')) mark('motion', { status: 'done' })
            mark('video', { status: 'running' })
          }
          if (p.status === 'music' && has('music')) {
            if (has('video')) mark('video', { status: 'done' })
            const pass = engine.beatState().model
            mark('music', { status: 'running', detail: pass.status === 'watching' ? t('editor.generate.watching', { percent: Math.round(pass.percent) }) : t('editor.generate.modelling') })
          }
        })
      } catch (e) {
        if (signal.aborted) return
        if (engine.generateState().status === 'cancelled') get().close()
        else set({ phase: 'error', error: message(e) })
        return
      } finally {
        if (nativeTask === run) nativeTask = null
      }
      if (signal.aborted) return
      if (setup && scripts.length > 0) {
        await invoke('generated:put', setup.key, setup.hash, toRows(scripts))
        if (signal.aborted) return
        void useRecompute.getState().check()
      }
      const p = engine.generateState()
      set({ progress: p })
      if (has('model')) mark('model', { status: 'done' })
      if (has('motion')) mark('motion', { status: 'done', detail: p.provider ? t('editor.generate.providerTime', { provider: p.provider, seconds: (p.modelMs / 1000).toFixed(1) }) : null })
      if (has('video')) mark('video', { status: 'done', detail: p.hits > 0 ? t('editor.generate.framesHits', { frames: Math.round(p.frames), hits: Math.round(p.hits) }) : t('editor.generate.frames', { frames: Math.round(p.frames) }) })
      if (has('music')) {
        const pass = engine.beatState().model
        mark('music', { status: pass.status === 'ready' ? 'done' : 'failed', detail: pass.status === 'ready' ? null : (pass.error ?? t('editor.generate.notReady')) })
      }
      set({ scripts: scripts.map((s) => ({ suffix: s.suffix, json: s.json })) })
      await get().save()
    },
    save: async () => {
      const { scripts, target } = get()
      const { signal } = task
      if (!scripts || !target || signal.aborted) return
      if (scripts.length === 0) {
        set({ phase: 'error', error: t('editor.generate.nothingTracked') })
        return
      }
      set({ phase: 'running' })
      mark('save', { status: 'running' })
      let paths: string[] | null
      try {
        paths = await invoke('dialog:saveScripts', target.path, target.title, scripts)
      } catch (e) {
        if (signal.aborted) return
        set({ phase: 'error', error: message(e) })
        return
      }
      if (signal.aborted) return
      mark('save', { status: paths ? 'done' : 'pending', detail: paths ? paths.map((p) => p.split(/[\\/]/).pop()).join(', ') : get().files.join(', ') })
      set({ phase: 'done', saved: paths })
    },
    openInEditor: async () => {
      const { scripts, target } = get()
      if (!scripts || !target) return
      const rows = scripts.flatMap((s) => {
        const axis = TRACK_AXES.find((a) => a.suffix === s.suffix)?.id
        return axis ? [{ axis, json: s.json }] : []
      })
      get().close()
      await useEditor.getState().openWithScripts(target.path, rows)
    },
    cancel: () => get().close(),
    close: () => {
      task.abort()
      if (nativeTask === task) engine.generateCancel()
      set({ open: false, phase: 'plan', progress: null, scripts: null, target: null })
    },
  }
})

usePlayer.subscribe((s, prev) => {
  const g = useGenerate.getState()
  if (s.path !== prev.path && g.phase === 'running' && !g.scripts) g.cancel()
})

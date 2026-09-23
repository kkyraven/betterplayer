import { beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type AccountStatus } from '@shared/account'
import { defaultTrackAxes, defaultTrackingDefaults, entitledMusicModel, DEFAULT_MODELS } from '@shared/tracking'

const VARIATION = 'music-variation'

const native = vi.hoisted(() => ({
  setModel: vi.fn(), setDetectOptions: vi.fn(), setTrackAxes: vi.fn(), generateCancel: vi.fn(),
  modelState: vi.fn(() => ({ status: 'none', runMs: 0 })),
}))
const chosen = vi.hoisted(() => ({ music: 'music' }))
vi.mock('@/engine/client', () => ({ engine: native, models: () => [
  { id: DEFAULT_MODELS.motion, kind: 'motion', files: [{ file: 'motion.onnx' }, { file: 'motion.json' }] },
  { id: DEFAULT_MODELS.music, kind: 'music', files: [{ file: 'music.onnx' }, { file: 'music.json' }] },
  { id: VARIATION, kind: 'music', files: [{ file: 'var.onnx' }, { file: 'var.json' }] },
] }))
vi.mock('@/ipc', () => ({ invoke: vi.fn(async (channel: string) => channel === 'models:dir' ? '/models' : Object.fromEntries(['motion.onnx', 'motion.json', 'music.onnx', 'music.json', 'var.onnx', 'var.json'].map((file) => [file, { path: `/models/${file}` }]))), on: vi.fn() }))
vi.mock('./audio', () => ({ releaseAudio: vi.fn(), ensureFullAudio: vi.fn(() => Promise.resolve()), ensureAudio: vi.fn() }))
vi.mock('@/screens/browser/StartPage', () => ({ siteName: vi.fn() }))
vi.mock('./browser', () => ({ useBrowser: { subscribe: vi.fn() }, feedColour: vi.fn(), subscribeFrames: vi.fn() }))
vi.mock('./player', () => ({ usePlayer: { getState: vi.fn() } }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./settings', async () => {
  const { defaultTrackingDefaults } = await import('@shared/tracking')
  return {
    useSettings: {
      subscribe: vi.fn(),
      getState: () => ({ settings: { tracking: { ...defaultTrackingDefaults(), models: { ...DEFAULT_MODELS, music: chosen.music } } } }),
    },
  }
})

import { useTracking } from './tracking'
import { useAccount } from './account'

const lastMusicModel = (): string | null | undefined =>
  native.setModel.mock.calls.filter((c) => c[0] === 'music').at(-1)?.[1] as string | null | undefined

const supporter: AccountStatus = { ...SIGNED_OUT, state: 'in', me: { id: 'test', name: '', email: 'test@example.com', friendCode: 'AAAA-BBBB', premium: true, admin: false } }

beforeEach(async () => {
  chosen.music = DEFAULT_MODELS.music ?? 'music'
  useAccount.setState({ status: SIGNED_OUT })
  useTracking.setState({ source: null, axes: defaultTrackAxes() })
  await useTracking.getState().refreshModels()
  vi.clearAllMocks()
})

it('falls back from the supporter model to CH without a subscription', () => {
  expect(entitledMusicModel(VARIATION, false)).toBe(DEFAULT_MODELS.music)
  expect(entitledMusicModel(VARIATION, true)).toBe(VARIATION)
  expect(entitledMusicModel(DEFAULT_MODELS.music, false)).toBe(DEFAULT_MODELS.music)
})

it('gives a free account CH on any axis', async () => {
  vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: vi.fn() })
  useTracking.setState({ source: 'player' })
  await useTracking.getState().refreshModels()
  expect(useTracking.getState().present).toMatchObject({ motion: true, music: true })
  useTracking.getState().setAxis('L0', { source: 'ai-music' })
  expect(useTracking.getState().axes.L0.source).toBe('ai-music')
  vi.unstubAllGlobals()
})

it('plays CH when a free account has the supporter model picked', async () => {
  chosen.music = VARIATION
  await useTracking.getState().refreshModels()
  expect(useTracking.getState().present.music).toBe(true)
  expect(native.setModel).not.toHaveBeenCalledWith('music', VARIATION, expect.anything(), expect.anything(), expect.anything())
})

it('loads the supporter model on subscription and drops back to CH on sign-out', async () => {
  chosen.music = VARIATION
  useAccount.setState({ status: supporter })
  await useTracking.getState().refreshModels()
  expect(native.setModel).toHaveBeenCalledWith('music', VARIATION, '/models/var.onnx', '/models/var.json', '/models')
  const axes = defaultTrackAxes()
  axes.L0.source = 'ai-music'
  useTracking.setState({ source: 'player', axes })
  useAccount.setState({ status: SIGNED_OUT })
  expect(native.generateCancel).toHaveBeenCalledOnce()
  expect(useTracking.getState().axes.L0.source).toBe('ai-music')
  await useTracking.getState().refreshModels()
  expect(lastMusicModel()).toBe(DEFAULT_MODELS.music)
  expect(useTracking.getState().present.music).toBe(true)
})

it('drops the supporter model from the engine the moment the subscription lapses', async () => {
  chosen.music = VARIATION
  useAccount.setState({ status: supporter })
  await useTracking.getState().refreshModels()
  vi.clearAllMocks()
  useAccount.setState({ status: SIGNED_OUT })
  expect(lastMusicModel()).toBe(null)
  expect(useTracking.getState().present.music).toBe(false)
})

it('reloads after entitlement is revoked and restored before a model refresh finishes', async () => {
  chosen.music = VARIATION
  await useTracking.getState().refreshModels()
  vi.clearAllMocks()
  useAccount.setState({ status: supporter })
  useAccount.setState({ status: SIGNED_OUT })
  useAccount.setState({ status: supporter })
  await useTracking.getState().refreshModels()
  expect(lastMusicModel()).toBe(VARIATION)
  expect(useTracking.getState().present.music).toBe(true)
})

it('keeps the tracking defaults usable without a signed-in account', () => {
  expect(defaultTrackingDefaults().models.music).toBe(DEFAULT_MODELS.music)
})

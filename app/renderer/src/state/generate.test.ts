import { beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type AccountStatus } from '@shared/account'
import { defaultTrackAxes } from '@shared/tracking'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), generateCancel: vi.fn(), generateState: vi.fn(() => ({ status: 'done' })), openWithScripts: vi.fn(), savedResult: vi.fn(), runGeneration: vi.fn(), waitForAudio: vi.fn(), currentSetup: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke, on: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine: { generateCancel: mocks.generateCancel, generateState: mocks.generateState } }))
vi.mock('./editor', () => ({ useEditor: { getState: () => ({ openWithScripts: mocks.openWithScripts }) } }))
vi.mock('./recompute', () => ({ useRecompute: { getState: () => ({ check: vi.fn() }) } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { isUrl: () => false, usePlayer: create(() => ({ path: '/video.mp4', title: 'video' })) }
})
vi.mock('./tracking', async () => {
  const { create } = await import('zustand')
  return { useTracking: create(() => ({ axes: defaultTrackAxes(), heroZone: null })) }
})
vi.mock('./generated', () => ({
  currentSetup: mocks.currentSetup,
  savedResult: mocks.savedResult, runGeneration: mocks.runGeneration,
  toFiles: () => [{ suffix: '', json: 'cached' }], toRows: vi.fn(), waitForAudio: mocks.waitForAudio,
}))
import { useAccount } from './account'
import { useGenerate } from './generate'
import { usePlayer } from './player'
import { useTracking } from './tracking'

const premium: AccountStatus = { ...SIGNED_OUT, state: 'in', me: { id: 'test', name: '', email: '', friendCode: '', premium: true, admin: false } }
beforeEach(() => {
  useGenerate.getState().close()
  useAccount.setState({ status: SIGNED_OUT })
  vi.resetAllMocks()
  usePlayer.setState({ path: '/video.mp4', title: 'video' })
  useTracking.setState({ axes: defaultTrackAxes() })
  mocks.currentSetup.mockReturnValue({ key: '/video.mp4', hash: 'current' })
  mocks.generateState.mockReturnValue({ status: 'done' })
  mocks.savedResult.mockResolvedValue(null)
})

it.each([
  ['signed out', SIGNED_OUT],
  ['free', { ...premium, me: { ...premium.me!, premium: false } }],
  ['subscribed', premium],
] as const)('confirms and exports cached scripts unchanged when %s', async (_, status) => {
  useAccount.setState({ status })
  mocks.savedResult.mockResolvedValue([{ axis: 'L0', json: 'cached' }])
  mocks.invoke.mockResolvedValue(['/video.funscript'])
  await useGenerate.getState().plan()
  expect(useGenerate.getState()).toMatchObject({ open: true, phase: 'plan', scripts: [{ suffix: '', json: 'cached' }] })
  expect(mocks.invoke).not.toHaveBeenCalled()
  await useGenerate.getState().start()
  expect(mocks.invoke).toHaveBeenCalledWith('dialog:saveScripts', '/video.mp4', 'video', [{ suffix: '', json: 'cached' }])
  expect(mocks.runGeneration).not.toHaveBeenCalled()
  expect(useGenerate.getState().saved).toEqual(['/video.funscript'])
})

it('allows signed-out users to generate, retry saving and open scripts in the editor', async () => {
  mocks.runGeneration.mockResolvedValue([{ axis: 'L0', suffix: '', json: 'generated' }])
  mocks.invoke.mockResolvedValue(null)
  await useGenerate.getState().plan()
  await useGenerate.getState().start()
  expect(mocks.runGeneration).toHaveBeenCalledOnce()
  expect(useGenerate.getState()).toMatchObject({ phase: 'done', scripts: [{ suffix: '', json: 'generated' }] })
  mocks.invoke.mockResolvedValue(['/video.funscript'])
  await useGenerate.getState().save()
  expect(useGenerate.getState().saved).toEqual(['/video.funscript'])
  await useGenerate.getState().openInEditor()
  expect(mocks.openWithScripts).toHaveBeenCalledWith('/video.mp4', [{ axis: 'L0', json: 'generated' }])
})

it('retains cached scripts when the account signs out during lookup', async () => {
  useAccount.setState({ status: premium })
  mocks.savedResult.mockImplementationOnce(async () => {
    useAccount.setState({ status: SIGNED_OUT })
    return [{ axis: 'L0', json: 'cached' }]
  })
  await useGenerate.getState().plan()
  expect(useGenerate.getState()).toMatchObject({ phase: 'plan', scripts: [{ suffix: '', json: 'cached' }] })
  await useGenerate.getState().start()
  expect(mocks.invoke).toHaveBeenCalledWith('dialog:saveScripts', '/video.mp4', 'video', [{ suffix: '', json: 'cached' }])
})

it('shows save failures instead of leaving the dialog running', async () => {
  useAccount.setState({ status: premium })
  await useGenerate.getState().plan()
  useGenerate.setState({ scripts: [{ suffix: '', json: 'cached' }], phase: 'running' })
  mocks.invoke.mockRejectedValueOnce(new Error('Disk full'))
  await useGenerate.getState().save()
  expect(useGenerate.getState()).toMatchObject({ phase: 'error', error: 'Disk full' })
})

it('finishes an active export when the account signs out', async () => {
  useAccount.setState({ status: premium })
  await useGenerate.getState().plan()
  const output = deferred<Array<{ axis: string; suffix: string; json: string }>>()
  mocks.runGeneration.mockReturnValueOnce(output.promise)
  mocks.invoke.mockResolvedValue(['/video.funscript'])
  const run = useGenerate.getState().start()
  useAccount.setState({ status: SIGNED_OUT })
  expect(mocks.generateCancel).not.toHaveBeenCalled()
  output.resolve([{ axis: 'L0', suffix: '', json: 'generated' }])
  await run
  expect(useGenerate.getState()).toMatchObject({ open: true, phase: 'done', saved: ['/video.funscript'] })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('keeps cached results tied to their original video through lookup, save retries and editor handoff', async () => {
  useAccount.setState({ status: premium })
  const lookup = deferred<Array<{ axis: string; json: string }>>()
  mocks.savedResult.mockReturnValueOnce(lookup.promise)
  mocks.invoke.mockResolvedValue(null)
  const plan = useGenerate.getState().plan()
  usePlayer.setState({ path: '/next.mp4', title: 'next' })
  lookup.resolve([{ axis: 'L0', json: 'cached' }])
  await plan
  expect(useGenerate.getState().target?.title).toBe('video')
  await useGenerate.getState().start()
  await useGenerate.getState().save()
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  expect(mocks.invoke).toHaveBeenLastCalledWith('dialog:saveScripts', '/video.mp4', 'video', [{ suffix: '', json: 'cached' }])
  await useGenerate.getState().openInEditor()
  expect(mocks.openWithScripts).toHaveBeenCalledWith('/video.mp4', [{ axis: 'L0', json: 'cached' }])
})

it.each(['resolve', 'reject'] as const)('does not resume a cancelled audio wait when it later %ss', async (settle) => {
  useAccount.setState({ status: premium })
  const axes = defaultTrackAxes()
  axes.L0.source = 'beat'
  useTracking.setState({ axes })
  const audio = deferred<string>()
  mocks.waitForAudio.mockReturnValueOnce(audio.promise)
  await useGenerate.getState().plan()
  const run = useGenerate.getState().start()
  const signal = mocks.waitForAudio.mock.calls[0]?.[1] as AbortSignal
  useGenerate.getState().cancel()
  expect(signal.aborted).toBe(true)
  expect(useGenerate.getState().open).toBe(false)
  expect(mocks.generateCancel).not.toHaveBeenCalled()
  await useGenerate.getState().plan()
  const steps = useGenerate.getState().steps
  if (settle === 'resolve') audio.resolve('120 BPM')
  else audio.reject(new Error('No audio'))
  await run
  expect(mocks.runGeneration).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(useGenerate.getState().steps).toBe(steps)
  expect(useGenerate.getState().phase).toBe('plan')
})

it('cancels and discards an unfinished generation when autoplay changes the video', async () => {
  useAccount.setState({ status: premium })
  const output = deferred<Array<{ axis: string; suffix: string; json: string }>>()
  mocks.runGeneration.mockReturnValueOnce(output.promise)
  await useGenerate.getState().plan()
  const run = useGenerate.getState().start()
  usePlayer.setState({ path: '/next.mp4', title: 'next' })
  expect(mocks.generateCancel).toHaveBeenCalledOnce()
  output.resolve([{ axis: 'L0', suffix: '', json: 'original' }])
  await run
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(useGenerate.getState()).toMatchObject({ open: false, scripts: null })
})

it('keeps freshly generated results on the original video after the save dialog is cancelled', async () => {
  useAccount.setState({ status: premium })
  mocks.runGeneration.mockResolvedValue([{ axis: 'L0', suffix: '', json: 'original' }])
  mocks.invoke.mockResolvedValue(null)
  await useGenerate.getState().plan()
  await useGenerate.getState().start()
  usePlayer.setState({ path: '/next.mp4', title: 'next' })
  await useGenerate.getState().save()
  expect(mocks.invoke).toHaveBeenLastCalledWith('dialog:saveScripts', '/video.mp4', 'video', [{ suffix: '', json: 'original' }])
  await useGenerate.getState().openInEditor()
  expect(mocks.openWithScripts).toHaveBeenCalledWith('/video.mp4', [{ axis: 'L0', json: 'original' }])
})

it('does not start generation for a different video than the confirmation', async () => {
  useAccount.setState({ status: premium })
  await useGenerate.getState().plan()
  usePlayer.setState({ path: '/next.mp4', title: 'next' })
  await useGenerate.getState().start()
  expect(mocks.runGeneration).not.toHaveBeenCalled()
  expect(useGenerate.getState().error).toBe('Video changed')
})

it('rejects a setup that changed after the axis summary was shown', async () => {
  useAccount.setState({ status: premium })
  await useGenerate.getState().plan()
  mocks.currentSetup.mockReturnValue({ key: '/video.mp4', hash: 'edited' })
  await useGenerate.getState().start()
  expect(mocks.runGeneration).not.toHaveBeenCalled()
  expect(useGenerate.getState().error).toBe('Tracking setup changed')
})

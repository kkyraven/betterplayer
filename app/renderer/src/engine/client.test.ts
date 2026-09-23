import { afterEach, expect, it, vi } from 'vitest'
import { FLAT } from '@shared/projection'
import { defaultUpscaling, type Upscaler } from '@shared/settings'

vi.mock('@/state/account', () => ({ isFree: () => true, useAccount: { getState: () => ({}) } }))
vi.mock('@/ipc', () => ({ invoke: vi.fn() }))

const argv = [...process.argv]
afterEach(() => {
  process.argv = argv
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

async function sizedClient(upscaler: Upscaler, dpr = 1) {
  vi.useFakeTimers()
  const native = { resize: vi.fn(), setEnhance: vi.fn(), enhanceCapabilities: () => ({}) }
  process.argv = [...argv, '--bp-engine=test-engine']
  vi.stubGlobal('window', {
    devicePixelRatio: dpr,
    addEventListener: vi.fn(),
    require: () => ({ Engine: class { constructor() { return native } } }),
  })
  const client = await import('./client')
  client.createEngine()
  client.applyEnhance({ ...defaultUpscaling(), upscaler })
  return { client, native }
}

it.each(['rtx', 'dlss'] as const)('%s renders a 1440p source at full UHD device resolution', async (upscaler) => {
  const { client } = await sizedClient(upscaler, 2)
  expect(client.outputSize(1920, 1080, FLAT, 2560, 1440)).toEqual([3840, 2160])
})

it('fits the picture and stereo eye to the viewport without forcing a minimum processing size', async () => {
  const { client } = await sizedClient('rtx', 2)
  expect(client.outputSize(1920, 1080, FLAT, 1920, 800)).toEqual([3840, 1600])
  expect(client.outputSize(1920, 1080, FLAT, 1080, 1920)).toEqual([1214, 2160])
  expect(client.outputSize(320, 180, FLAT, 3840, 2160)).toEqual([640, 360])
  expect(client.outputSize(1920, 1080, { ...FLAT, layout: 'sbs' }, 3840, 1080)).toEqual([3840, 2160])
  expect(client.outputSize(1920, 1080, { ...FLAT, layout: 'ou' }, 1920, 2160)).toEqual([3840, 2160])
})

it('bounds enhanced readback by pixel count while preserving wide and tall display shapes', async () => {
  const { client } = await sizedClient('dlss')
  expect(client.outputSize(7680, 4320, FLAT, 1920, 1080)).toEqual([3840, 2160])
  expect(client.outputSize(2160, 3840, FLAT, 1080, 1920)).toEqual([2160, 3840])
  expect(client.outputSize(5120, 1440, FLAT, 3840, 1080)).toEqual([5120, 1440])
  for (const [w, h] of [[12000, 6000], [32000, 100], [6000, 12000]] as const) {
    const [outW, outH] = client.outputSize(w, h, { ...FLAT, kind: 'equirect360' }, 7680, 3840)
    expect(outW * outH).toBeLessThanOrEqual(client.MAX_OUTPUT_PIXELS)
    expect(Math.max(outW, outH)).toBeLessThanOrEqual(8192)
    expect(outW % 2).toBe(0)
    expect(outH % 2).toBe(0)
  }
})

it('retains source and readback limits with enhancement off and refits on toggles', async () => {
  const { client, native } = await sizedClient('off', 2)
  expect(client.outputSize(1920, 1080, FLAT, 1280, 720)).toEqual([1280, 720])
  expect(client.outputSize(1920, 1080, FLAT, 7680, 4320)).toEqual([2560, 1440])
  client.resize(1920, 1080, FLAT, 1280, 720)
  client.applyEnhance({ ...defaultUpscaling(), upscaler: 'rtx' })
  expect(native.resize.mock.lastCall?.slice(0, 2)).toEqual([3840, 2160])
  client.applyEnhance(defaultUpscaling())
  expect(native.resize.mock.lastCall?.slice(0, 2)).toEqual([1280, 720])
})

it('keeps the attached buffers and dimensions after a failed resize, then retries', async () => {
  vi.useFakeTimers()
  const resize = vi.fn()
  const native = { resize, acquire: () => 0, enhanceCapabilities: () => ({}) }
  process.argv = [...argv, '--bp-engine=test-engine']
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    require: () => ({ Engine: class { constructor() { return native } } }),
  })
  const client = await import('./client')
  client.createEngine()
  const old = client.frames
  resize.mockImplementationOnce(() => { throw new Error('allocation failed') })
  expect(() => client.resize(640, 360, FLAT, 1280, 720)).toThrow('allocation failed')
  expect([client.width, client.height]).toEqual([2, 2])
  expect(client.acquireFrame()).toBe(old[0])
  client.resize(640, 360, FLAT, 1280, 720)
  expect(resize).toHaveBeenCalledTimes(2)
  expect([client.width, client.height]).toEqual([640, 360])
  expect(client.acquireFrame()).toBe(client.frames[0])
  expect(client.frames).not.toBe(old)
})

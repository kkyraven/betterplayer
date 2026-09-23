import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/ipc', () => ipc)
vi.mock('./ui', () => ({ useUi: { getState: () => ({ screen: 'settings', setReduceTransparency: vi.fn() }) } }))
import { useSettings } from './settings'
import { useSettingsFeedback } from './settingsFeedback'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  ipc.invoke.mockReset().mockResolvedValue(undefined)
  useSettings.setState({ settings: defaultSettings() })
  useSettingsFeedback.setState({ current: { page: 'subtitles', target: 'height-above-the-bottom' }, errors: {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('keeps the debounced edit after its page has gone away', async () => {
  useSettings.getState().updateDebounced((s) => ({ ...s, subtitles: { ...s.subtitles, position: 0.2 } }))
  useSettingsFeedback.setState({ current: null })
  await vi.advanceTimersByTimeAsync(299)
  expect(ipc.invoke).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ipc.invoke).toHaveBeenCalledWith('settings:set', expect.objectContaining({ subtitles: expect.objectContaining({ position: 0.2 }) }))
})
it('serializes writes and clears an earlier failure when a queued full document succeeds', async () => {
  let rejectFirst: (reason: Error) => void = () => undefined
  ipc.invoke.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      }),
  )
  const first = useSettings.getState().update((s) => ({ ...s, subtitles: { ...s.subtitles, position: 0.2 } }))
  await Promise.resolve()
  useSettingsFeedback.setState({ current: { page: 'privacy', target: 'send-usage-stats' } })
  const second = useSettings.getState().update((s) => ({ ...s, account: { ...s.account, usageStats: false } }))
  expect(ipc.invoke).toHaveBeenCalledTimes(1)
  rejectFirst(new Error('Disk full'))
  await expect(first).rejects.toThrow('Disk full')
  await second
  expect(ipc.invoke).toHaveBeenCalledTimes(2)
  expect(ipc.invoke.mock.calls[1]?.[1]).toMatchObject({ subtitles: { position: 0.2 }, account: { usageStats: false } })
  expect(useSettingsFeedback.getState().errors).toEqual({})
})
it('reports a debounced write failure at its original setting', async () => {
  ipc.invoke.mockRejectedValueOnce(new Error('Disk full'))
  useSettings.getState().updateDebounced((s) => ({ ...s, subtitles: { ...s.subtitles, position: 0.2 } }))
  useSettingsFeedback.setState({ current: { page: 'privacy', target: 'send-usage-stats' } })
  await vi.advanceTimersByTimeAsync(300)
  expect(useSettingsFeedback.getState().errors['subtitles:height-above-the-bottom']?.message).toBe('Disk full')
})

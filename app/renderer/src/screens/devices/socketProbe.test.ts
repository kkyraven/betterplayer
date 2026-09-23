import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchSocket } from './socketProbe'

class Socket {
  static opened: Socket[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { Socket.opened.push(this) }
}

beforeEach(() => {
  vi.useFakeTimers()
  Socket.opened = []
  vi.stubGlobal('WebSocket', Socket)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('detects a server started after setup opens and cancels probes on exit', () => {
  const report = vi.fn()
  const stop = watchSocket('ws://127.0.0.1:12346', report)
  vi.advanceTimersByTime(300)
  Socket.opened[0]?.onerror?.()
  expect(report).toHaveBeenLastCalledWith(false)
  vi.advanceTimersByTime(2000)
  Socket.opened[1]?.onopen?.()
  expect(report).toHaveBeenLastCalledWith(true)
  stop()
  vi.advanceTimersByTime(5000)
  expect(Socket.opened).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('handles a silent server and closes an outstanding probe on exit', () => {
  const report = vi.fn()
  const stop = watchSocket('ws://127.0.0.1:12346', report)
  vi.advanceTimersByTime(1800)
  expect(report).toHaveBeenLastCalledWith(false)
  expect(Socket.opened[0]?.close).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(2000)
  stop()
  expect(Socket.opened[1]?.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

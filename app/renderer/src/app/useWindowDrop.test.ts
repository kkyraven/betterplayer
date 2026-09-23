import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  setDragging: vi.fn(),
  cleanup: undefined as (() => void) | undefined,
}))
vi.mock('react', () => ({
  useState: () => [false, hooks.setDragging],
  useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup = effect() },
}))
vi.mock('@/node', () => ({ electron: { webUtils: { getPathForFile: () => '/media/video.mp4' } } }))
import { useWindowDrop } from './useWindowDrop'

function drag(type: string, types: string[], files: object[] = []) {
  const event = new Event(type, { cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types, files } })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
  hooks.setDragging.mockClear()
})
afterEach(() => {
  hooks.cleanup?.()
  hooks.cleanup = undefined
  vi.unstubAllGlobals()
})

it('ignores internal playlist drags without taking over their drop operation', () => {
  const open = vi.fn()
  useWindowDrop(open)
  const types = ['application/x-betterplayer-sidebar-playlist']
  expect(drag('dragenter', types).defaultPrevented).toBe(false)
  expect(drag('dragover', types).defaultPrevented).toBe(false)
  expect(drag('drop', types).defaultPrevented).toBe(false)
  expect(hooks.setDragging).not.toHaveBeenCalledWith(true)
  expect(open).not.toHaveBeenCalled()
})

it('still opens external files and clears the overlay on drop', () => {
  const open = vi.fn()
  useWindowDrop(open)
  drag('dragenter', ['Files'])
  drag('dragenter', ['Files'])
  drag('dragleave', ['Files'])
  expect(hooks.setDragging).toHaveBeenLastCalledWith(true)
  expect(drag('dragover', ['Files']).defaultPrevented).toBe(true)
  drag('drop', ['Files'], [{}])
  expect(hooks.setDragging).toHaveBeenLastCalledWith(false)
  expect(open).toHaveBeenCalledWith(['/media/video.mp4'])
})

it('clears a cancelled drag even when no drop reaches the window', () => {
  useWindowDrop(vi.fn())
  drag('dragenter', ['Files'])
  drag('dragenter', ['Files'])
  drag('dragend', ['Files'])
  expect(hooks.setDragging).toHaveBeenLastCalledWith(false)
  drag('dragenter', ['Files'])
  drag('dragleave', ['Files'])
  expect(hooks.setDragging).toHaveBeenLastCalledWith(false)
})

it('clears the overlay when disabled and removes listeners on cleanup', () => {
  useWindowDrop(vi.fn())
  drag('dragenter', ['Files'])
  hooks.cleanup?.()
  hooks.setDragging.mockClear()
  drag('dragenter', ['Files'])
  expect(hooks.setDragging).not.toHaveBeenCalled()
  useWindowDrop(vi.fn(), false)
  expect(hooks.setDragging).toHaveBeenLastCalledWith(false)
  drag('dragenter', ['Files'])
  expect(hooks.setDragging).not.toHaveBeenCalledWith(true)
})

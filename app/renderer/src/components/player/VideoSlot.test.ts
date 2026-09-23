import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HTMLAttributes, MouseEvent, PointerEvent, ReactElement } from 'react'

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: (current: unknown) => ({ current }),
  useEffect: vi.fn(),
}))
vi.mock('./AudioArt', () => ({ AudioArt: () => null }))
vi.mock('./Subtitles', () => ({ Subtitles: () => null }))
vi.mock('./stage', () => ({ videoStage: vi.fn() }))
import { VideoSlot } from './VideoSlot'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function slot() {
  const click = vi.fn()
  const doubleClick = vi.fn()
  const element = VideoSlot({ onClick: click, onDoubleClick: doubleClick }) as ReactElement<HTMLAttributes<HTMLDivElement>>
  const props = element.props
  const down = () => props.onPointerDown?.({ button: 0, clientX: 0, clientY: 0 } as PointerEvent<HTMLDivElement>)
  const move = (buttons: number) => props.onPointerMove?.({ buttons, clientX: 20, clientY: 0 } as PointerEvent<HTMLDivElement>)
  const release = (detail = 1) => props.onClick?.({ detail } as MouseEvent<HTMLDivElement>)
  return { click, doubleClick, props, down, move, release }
}

it('toggles once for a click, even when the cursor moves after release', () => {
  const s = slot()
  s.down()
  s.release()
  s.move(0)
  vi.runAllTimers()
  expect(s.click).toHaveBeenCalledOnce()
})

it('leaves double click to fullscreen', () => {
  const s = slot()
  s.down()
  s.release()
  vi.advanceTimersByTime(100)
  s.down()
  s.release(2)
  s.props.onDoubleClick?.({} as MouseEvent<HTMLDivElement>)
  vi.runAllTimers()
  expect(s.click).not.toHaveBeenCalled()
  expect(s.doubleClick).toHaveBeenCalledOnce()
})

it('does not toggle after dragging the picture', () => {
  const s = slot()
  s.down()
  s.move(1)
  s.release()
  vi.runAllTimers()
  expect(s.click).not.toHaveBeenCalled()
})

it('cancels a pending click when another drag starts', () => {
  const s = slot()
  s.down()
  s.release()
  s.down()
  s.move(1)
  s.release(2)
  vi.runAllTimers()
  expect(s.click).not.toHaveBeenCalled()
})

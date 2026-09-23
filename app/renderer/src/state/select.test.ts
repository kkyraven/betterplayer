import { beforeEach, expect, it } from 'vitest'
import { useSelect } from './select'

beforeEach(() => useSelect.getState().clear())

it('select all keeps the prior selection for undo', () => {
  const s = useSelect.getState()
  s.start(2)
  s.toggle(5)
  s.setAll([1, 2, 3, 4, 5])
  expect([...useSelect.getState().ids]).toEqual([1, 2, 3, 4, 5])
  expect([...useSelect.getState().before ?? []]).toEqual([2, 5])
})

it('undo restores exactly that selection', () => {
  const s = useSelect.getState()
  s.start(2)
  s.toggle(5)
  s.setAll([1, 2, 3, 4, 5])
  useSelect.getState().undoAll()
  expect([...useSelect.getState().ids]).toEqual([2, 5])
  expect(useSelect.getState().before).toBeNull()
  expect(useSelect.getState().on).toBe(true)
})

it('touching a card after select all drops undo', () => {
  const s = useSelect.getState()
  s.start(2)
  s.setAll([1, 2, 3])
  useSelect.getState().toggle(3)
  expect(useSelect.getState().before).toBeNull()
  expect([...useSelect.getState().ids]).toEqual([1, 2])
})

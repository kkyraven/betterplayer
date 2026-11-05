import { describe, expect, it } from 'vitest'
import { Endpointer } from './endpoint'

const run = (ms: number, p: number) => new Array<number>(Math.round(ms / 32)).fill(p)

describe('Endpointer', () => {
  it('starts after 250 ms of speech and ends after 900 ms of quiet (whole frames: 256 and 928 ms)', () => {
    const e = new Endpointer()
    e.push(run(320, 0.1))
    expect(e.push(run(224, 0.9))).toBe('none')
    expect(e.started).toBe(false)
    e.push(run(32, 0.9))
    expect(e.started).toBe(true)
    expect(e.startSample).toBe(10 * 512 - 4800)
    e.push(run(1000, 0.9))
    expect(e.push(run(896, 0.1))).toBe('none')
    expect(e.push(run(32, 0.1))).toBe('speech')
  })

  it('starts on speech spread over the window, not on stray blips', () => {
    const blips = new Endpointer()
    for (let i = 0; i < 40; i++) blips.push([0.9, 0.1, 0.1])
    expect(blips.started).toBe(false)
    const choppy = new Endpointer()
    for (let i = 0; i < 5; i++) choppy.push([0.9, 0.9, 0.1])
    expect(choppy.started).toBe(true)
  })

  it('keeps going through soft syllables and short pauses', () => {
    const e = new Endpointer()
    e.push(run(500, 0.9))
    for (let i = 0; i < 10; i++) e.push([...run(800, 0.1), ...run(96, 0.4)])
    expect(e.end).toBe('none')
  })

  it('is silent when nobody starts within 6 s', () => {
    const e = new Endpointer()
    e.push(run(5984, 0.1))
    expect(e.end).toBe('none')
    expect(e.push(run(32, 0.1))).toBe('silent')
    expect(e.startSample).toBeNull()
  })

  it('stops 20 s after the start whatever is still heard', () => {
    const e = new Endpointer()
    e.push(run(19_968, 0.9))
    expect(e.end).toBe('none')
    expect(e.push(run(32, 0.9))).toBe('speech')
  })

  it('ignores frames after the end', () => {
    const e = new Endpointer()
    e.push(run(6016, 0))
    e.push(run(1000, 1))
    expect(e.end).toBe('silent')
    expect(e.samples).toBe(188 * 512)
  })
})

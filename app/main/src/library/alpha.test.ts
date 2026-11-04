import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALPHA_GREY, alphaSize, appAlpha, besideAlpha, findAlpha, medianOfThree } from './alpha'

describe('external alpha', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('is found beside the video first, then in the app folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-alpha-'))
    const video = join(dir, 'scene.mkv')
    const own = appAlpha(dir, '7')
    expect(findAlpha(video, dir, '7')).toBeNull()
    writeFileSync(own, '')
    expect(findAlpha(video, dir, '7')).toBe(own)
    writeFileSync(join(dir, 'scene_XALPHA.mp4'), '')
    expect(besideAlpha(video)).toBe(join(dir, 'scene_XALPHA.mp4'))
    expect(findAlpha(video, dir, '7')).toBe(join(dir, 'scene_XALPHA.mp4'))
  })

  it('writes grey that HereSphere sums back to the mask', () => {
    const lin = (g: number) => ((g / 255) <= 0.04045 ? g / 255 / 12.92 : ((g / 255 + 0.055) / 1.055) ** 2.4)
    expect(ALPHA_GREY[0]).toBe(0)
    expect(ALPHA_GREY[255]).toBe(255)
    for (const v of [32, 128, 200, 254]) expect(Math.abs(3 * lin(ALPHA_GREY[v] ?? 0) - v / 255)).toBeLessThan(0.01)
  })

  it('holds a cell the model flips for one grid', () => {
    const out = new Uint8Array(3)
    expect([...medianOfThree(Uint8Array.of(0, 255, 10), Uint8Array.of(255, 0, 20), Uint8Array.of(0, 255, 30), out)]).toEqual([0, 255, 20])
  })

  it('is 480 high per eye in the source shape', () => {
    expect(alphaSize(7680, 3840, 'sbs')).toEqual([960, 480])
    expect(alphaSize(4096, 4096, 'ou')).toEqual([960, 960])
    expect(alphaSize(640, 320, 'sbs')).toEqual([640, 320])
  })
})

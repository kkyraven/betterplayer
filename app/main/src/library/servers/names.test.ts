import { describe, expect, it } from 'vitest'
import { scriptFileNames } from './names'

describe('scriptFileNames', () => {
  it('names a single script plainly whatever it was called', () => {
    expect(scriptFileNames(['Some Scene.funscript'])).toEqual(['video.funscript'])
    expect(scriptFileNames([''])).toEqual(['video.funscript'])
  })

  it('keeps the suffixes past a shared stem', () => {
    expect(scriptFileNames(['scene.funscript', 'scene.pitch.funscript', 'scene.roll.funscript'])).toEqual(['video.funscript', 'video.pitch.funscript', 'video.roll.funscript'])
    expect(scriptFileNames(['clip_a.funscript', 'clip_a_surge.funscript'])).toEqual(['video.funscript', 'video.surge.funscript'])
  })

  it('keeps bare axis ids and unrelated names as suffixes', () => {
    expect(scriptFileNames(['L0', 'R1'])).toEqual(['video.L0.funscript', 'video.R1.funscript'])
    expect(scriptFileNames(['stroke.funscript', 'twist.funscript'])).toEqual(['video.stroke.funscript', 'video.twist.funscript'])
  })

  it('never lets a name escape the folder', () => {
    expect(scriptFileNames(['../x.funscript', 'a/b.funscript'])).toEqual(['video._x.funscript', 'video.a_b.funscript'])
  })
})


it('preserves the axis when the only script is an axis script', () => {
  expect(scriptFileNames(['scene.pitch.funscript'])).toEqual(['video.pitch.funscript'])
  expect(scriptFileNames(['R1'])).toEqual(['video.R1.funscript'])
})

it('keeps scripts whose sanitized names collide in separate files', () => {
  expect(scriptFileNames(['a/b.funscript', 'a b.funscript', 'A_B.funscript'])).toEqual(['video.a_b.funscript', 'video.a_b.2.funscript', 'video.A_B.3.funscript'])
})

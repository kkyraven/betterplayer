import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { findEstimAudio } from './estimAudio'

let root = ''
const file = (...parts: string[]) => {
  const path = join(root, ...parts)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bp-estim-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('finds the audio a folder down for a video alone in its folder', async () => {
  const video = file('Night Terrors #1', 'Night Terrors #1.mp4')
  const audio = file('Night Terrors #1', 'Night-Terrors', 'Night Terrors.mp3')
  file('Night Terrors #1', 'Night-Terrors', 'Night Terrors.mp3.part')
  expect(await findEstimAudio(video)).toBe(audio)
})

it("leaves a folder below that holds a video of its own, and a folder of many videos' folders", async () => {
  const video = file('Euphoria', 'Euphoria.mp4')
  file('Euphoria', 'Euphoria 2', 'Euphoria 2.mp4')
  file('Euphoria', 'Euphoria 2', 'Euphoria 2.mp3')
  expect(await findEstimAudio(video)).toBeNull()
  const beside = file('Euphoria', 'Euphoria.mp3')
  expect(await findEstimAudio(video)).toBe(beside)
})

it('finds nothing for an audio file, which plays as music', async () => {
  const song = file('Music', 'Song.mp3')
  file('Music', 'Song (stim).mp3')
  expect(await findEstimAudio(song)).toBeNull()
})

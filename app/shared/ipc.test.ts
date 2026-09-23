import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, isAudioPath, isMediaPath, isVideoPath } from './ipc'

describe('media paths', () => {
  it('matches on the last extension, any case', () => {
    expect(isVideoPath('/v/clip.MKV')).toBe(true)
    expect(isVideoPath('/v/clip.h264.mp4')).toBe(true)
    expect(isVideoPath('/v/clip.mp4.bak')).toBe(false)
    expect(isVideoPath('/v/ts')).toBe(false)
    expect(isVideoPath('/v/.ts')).toBe(false)
    expect(isVideoPath('/v.mp4/queue')).toBe(false)
    expect(isVideoPath('C:\\v.mp4\\queue')).toBe(false)
    expect(isAudioPath('C:\\music\\song.Flac')).toBe(true)
    expect(isMediaPath('/v/clip.funscript')).toBe(false)
  })

  it('keeps video and audio apart', () => {
    for (const ext of VIDEO_EXTENSIONS) expect(AUDIO_EXTENSIONS).not.toContain(ext)
  })
})

describe('electron-builder.yml file associations', () => {
  const yml = readFileSync(fileURLToPath(new URL('../electron-builder.yml', import.meta.url)), 'utf8')
  const lists = [...yml.matchAll(/^\s+ext: \[(.*)\]$/gm)].map((m) => (m[1] ?? '').split(',').map((e) => e.trim().replace(/^"|"$/g, '')))

  it('registers the same extensions the app opens', () => {
    expect(lists).toEqual([[...VIDEO_EXTENSIONS], [...AUDIO_EXTENSIONS]])
  })
})

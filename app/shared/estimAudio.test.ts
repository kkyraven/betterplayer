import { describe, expect, it } from 'vitest'
import { estimAudioPlan, pickEstimAudio, readEstimAudioVideo } from './estimAudio'

describe('pickEstimAudio', () => {
  it('finds the audio of the layouts creators ship', () => {
    expect(pickEstimAudio('D:\\estim\\Euphoria7\\Euphoria 7.mp4', ['D:\\estim\\Euphoria7\\Euphoria 7.mp3'], ['D:\\estim\\Euphoria7\\Euphoria 7.mp4'])).toBe('D:\\estim\\Euphoria7\\Euphoria 7.mp3')
    const night = 'D:\\estim\\Night Terrors #1\\Night Terrors #1.mp4'
    expect(pickEstimAudio(night, ['D:\\estim\\Night Terrors #1\\Night-Terrors\\Night Terrors.mp3'], [night])).toBe('D:\\estim\\Night Terrors #1\\Night-Terrors\\Night Terrors.mp3')
    expect(pickEstimAudio('/v/Session.mkv', ['/v/session.OGG'], [])).toBe('/v/session.OGG')
  })

  it('prefers the same name beside the video, then a folder down, then a longer or shorter name', () => {
    const video = '/v/Clip.mp4'
    expect(pickEstimAudio(video, ['/v/Clip stim.mp3', '/v/sub/Clip.wav', '/v/Clip.mp3'], [video])).toBe('/v/Clip.mp3')
    expect(pickEstimAudio(video, ['/v/Clip stim.mp3', '/v/sub/Clip.wav'], [video])).toBe('/v/sub/Clip.wav')
    expect(pickEstimAudio(video, ['/v/Clip stim.mp3'], [video])).toBe('/v/Clip stim.mp3')
  })

  it("leaves another video's audio and unrelated files alone", () => {
    const videos = ['/v/Part.mp4', '/v/Part 2.mp4']
    expect(pickEstimAudio('/v/Part 2.mp4', ['/v/Part.mp3'], videos)).toBeNull()
    expect(pickEstimAudio('/v/Part.mp4', ['/v/Part.mp3'], videos)).toBe('/v/Part.mp3')
    expect(pickEstimAudio('/v/Clip.mp4', ['/v/Clipper.mp3', '/v/music.mp3', '/v/Clip.mp3.part', '/v/Clip.funscript'], [])).toBeNull()
    expect(pickEstimAudio('/v/ab 1.mp4', ['/v/ab.mp3'], [])).toBeNull()
  })

  it('never picks the open file itself, as music opened in the player', () => {
    expect(pickEstimAudio('D:\\Music\\Song.mp3', ['d:/music/song.MP3'], [])).toBeNull()
  })

  it('gives a file to the video that names it best, and none when names leave it unclear', () => {
    const videos = ['/v/Hypno.mp4', '/v/Hypno 2.mp4']
    expect(pickEstimAudio('/v/Hypno.mp4', ['/v/Hypno 2 estim.mp3'], videos)).toBeNull()
    expect(pickEstimAudio('/v/Hypno 2.mp4', ['/v/Hypno 2 estim.mp3'], videos)).toBe('/v/Hypno 2 estim.mp3')
    const parts = ['/v/Night Terrors 1.mp4', '/v/Night Terrors 2.mp4']
    expect(pickEstimAudio('/v/Night Terrors 1.mp4', ['/v/Night Terrors.mp3'], parts)).toBeNull()
    expect(pickEstimAudio('/v/Clip.mp4', ['/v/Clip music.mp3', '/v/Clip e-stim.mp3'], [])).toBe('/v/Clip e-stim.mp3')
    expect(pickEstimAudio('/v/Clip.mp4', ['/v/Clip a.mp3', '/v/Clip b.mp3'], [])).toBeNull()
  })

  it('reads either slash as the same folder', () => {
    expect(pickEstimAudio('D:/v/Clip.mp4', ['D:\\v\\sub\\Clip stim.mp3', 'D:\\v\\Clip stim.mp3'], [])).toBe('D:\\v\\Clip stim.mp3')
  })
})

describe('estimAudioPlan', () => {
  it('plays the file found, or the one linked, as the estim', () => {
    expect(estimAudioPlan('/v/a.mp4', '/v/a.mp3', undefined)).toEqual({ media: '/v/a.mp4', estim: '/v/a.mp3', swapChannels: false })
    expect(estimAudioPlan('/v/a.mp4', '/v/a.mp3', { file: '/x/b.wav', swapChannels: true })).toEqual({ media: '/v/a.mp4', estim: '/x/b.wav', swapChannels: true })
    expect(estimAudioPlan('/v/a.mp4', null, undefined)).toBeNull()
    expect(estimAudioPlan('/v/a.mp4', '/v/a.mp3', { file: null })).toBeNull()
  })

  it("swapped, plays the video's own audio as the estim and the file in its place", () => {
    expect(estimAudioPlan('/v/a.mp4', '/v/a.mp3', { swap: true })).toEqual({ media: '/v/a.mp4', estim: '/v/a.mp4', music: '/v/a.mp3', swapChannels: false })
    expect(estimAudioPlan('/v/a.mp4', null, { swap: true })).toEqual({ media: '/v/a.mp4', estim: '/v/a.mp4', swapChannels: false })
  })
})

describe('reading what was stored', () => {
  it("keeps a video's choices and nothing that changes nothing", () => {
    expect(readEstimAudioVideo({ file: '/x/b.wav', swap: true, swapChannels: false, other: 1 })).toEqual({ file: '/x/b.wav', swap: true })
    expect(readEstimAudioVideo({ file: '', swap: false })).toBeUndefined()
    expect(readEstimAudioVideo({ file: null })).toEqual({ file: null })
    expect(readEstimAudioVideo('nope')).toBeUndefined()
  })
})

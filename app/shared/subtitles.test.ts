import { describe, expect, it } from 'vitest'
import { cueAt, parseSubtitles, sidecarTrack, sortTracks } from './subtitles'

describe('sidecarTrack', () => {
  it('matches the plain name and a language tag, nothing else', () => {
    expect(sidecarTrack('scene.mp4', 'scene.srt', '/v/')).toEqual({ path: '/v/scene.srt', label: 'default' })
    expect(sidecarTrack('scene.mp4', 'scene.en.vtt', '/v/')).toEqual({ path: '/v/scene.en.vtt', label: 'en' })
    expect(sidecarTrack('scene.mp4', 'scene.funscript', '/v/')).toBeNull()
    expect(sidecarTrack('scene.mp4', 'scene 2.srt', '/v/')).toBeNull()
    expect(sidecarTrack('scene.mp4', 'scene.en.forced.srt', '/v/')).toBeNull()
  })
  it('puts the plain track first', () => {
    const sorted = sortTracks([
      { path: 'b', label: 'fr' },
      { path: 'a', label: 'default' },
      { path: 'c', label: 'en' },
    ])
    expect(sorted.map((t) => t.label)).toEqual(['default', 'en', 'fr'])
  })
})

describe('parseSubtitles', () => {
  it('reads SRT with a BOM, CRLF, tags and multi-line text', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,000\r\n{\\an8}Top\r\n'
    expect(parseSubtitles(srt, 'srt')).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello\nthere' },
      { startMs: 60_000, endMs: 61_000, text: 'Top' },
    ])
  })
  it('reads VTT, skipping the header and cue settings', () => {
    const vtt = 'WEBVTT\n\nNOTE a comment\n\nintro\n00:03.000 --> 00:05.000 line:90%\nHi\n'
    expect(parseSubtitles(vtt, 'vtt')).toEqual([{ startMs: 3000, endMs: 5000, text: 'Hi' }])
  })
  it('reads ASS dialogue in Format order with \\N breaks and override blocks dropped', () => {
    const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\b1}One,\\Ntwo\nComment: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,no\n'
    expect(parseSubtitles(ass, 'ass')).toEqual([{ startMs: 1500, endMs: 3000, text: 'One,\ntwo' }])
  })
  it('drops empty and inverted cues and sorts by start', () => {
    const srt = '1\n00:00:05,000 --> 00:00:06,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:09,000 --> 00:00:08,000\nX\n\n4\n00:00:03,000 --> 00:00:04,000\n<i></i>\n'
    expect(parseSubtitles(srt, 'srt').map((c) => c.text)).toEqual(['A', 'B'])
  })
})

describe('cueAt', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'a' },
    { startMs: 2000, endMs: 3000, text: 'b' },
    { startMs: 2500, endMs: 2600, text: 'c' },
    { startMs: 4000, endMs: 5000, text: 'd' },
  ]
  it('finds the cue at a time and nothing in the gaps', () => {
    expect(cueAt(cues, 500)).toBe(0)
    expect(cueAt(cues, 1500)).toBe(-1)
    expect(cueAt(cues, 2000)).toBe(1)
    expect(cueAt(cues, 3000)).toBe(-1)
    expect(cueAt(cues, 4999)).toBe(3)
    expect(cueAt([], 10)).toBe(-1)
  })
  it('prefers the latest overlapping cue, and falls back to the one still showing', () => {
    expect(cueAt(cues, 2550)).toBe(2)
    expect(cueAt(cues, 2700)).toBe(1)
  })
})

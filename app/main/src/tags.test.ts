import { describe, expect, it } from 'vitest'
import { parseTags } from './tags'

describe('parseTags', () => {
  it('reads container tags and the attached picture of an mp3', () => {
    const json = {
      streams: [
        { index: 0, codec_type: 'audio', tags: {} },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      ],
      format: { tags: { title: 'Midnight Circuit', artist: 'Nova Kline', album: 'Signal Bloom', date: '2024-03-01' } },
    }
    expect(parseTags(json)).toEqual({ video: false, title: 'Midnight Circuit', artist: 'Nova Kline', album: 'Signal Bloom', year: 2024, pictureIndex: 1 })
  })

  it('falls back to the audio stream tags, ignoring key case', () => {
    const json = { streams: [{ index: 0, codec_type: 'audio', tags: { TITLE: 'Track', ALBUM_ARTIST: 'Someone' } }], format: {} }
    expect(parseTags(json)).toMatchObject({ video: false, title: 'Track', artist: 'Someone', album: null, year: null, pictureIndex: null })
  })

  it('treats a real video stream as video, whatever the tags', () => {
    const json = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } }, { index: 1, codec_type: 'audio' }], format: { tags: { title: 'Clip' } } }
    expect(parseTags(json)).toMatchObject({ video: true, title: 'Clip' })
  })

  it('survives output with nothing in it', () => {
    expect(parseTags({})).toEqual({ video: false, title: null, artist: null, album: null, year: null, pictureIndex: null })
  })
})

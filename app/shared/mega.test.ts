import { describe, expect, it } from 'vitest'
import { megaDownloadName } from './mega'

describe('MEGA saved filenames', () => {
  it('recognizes the exact saved name when MEGA replaces invalid characters', () => {
    const savedName = megaDownloadName('Example: ride.mp4')
    expect(savedName).toBe('Example- ride.mp4')
    expect(savedName === 'Example- other ride.mp4').toBe(false)
    expect(savedName === 'Example- ride.mp4.exe').toBe(false)
    expect(megaDownloadName('scene"*/:<>?\\|take.funscript')).toBe('scene-take.funscript')
    expect(megaDownloadName('scene: take / two.mp4')).toBe('scene- take - two.mp4')
  })

  it('prefixes reserved Windows names without changing similar filenames', () => {
    for (const name of ['con', 'PRN.mp4', 'aux.funscript', 'NuL.zip', 'COM0.mp4', 'com9.funscript', 'LPT1.zip', 'lpt9.mp4']) {
      expect(megaDownloadName(name)).toBe(`!${name}`)
    }
    for (const name of ['console.mp4', 'com10.mp4', 'lpt10.mp4', 'con.extra.mp4', '.con', 'con ']) {
      expect(megaDownloadName(name)).toBe(name)
    }
  })

  it('shortens long names with the final extension and uses the provider character limit', () => {
    expect(megaDownloadName(`${'a'.repeat(236)}.mp4`)).toBe(`${'a'.repeat(236)}.mp4`)
    expect(megaDownloadName(`${'a'.repeat(237)}.mp4`)).toBe(`${'a'.repeat(237)}.mp.mp4`)
    expect(megaDownloadName(`${'a'.repeat(241)}.cut.funscript`)).toBe(`${'a'.repeat(240)}.funscript`)
    expect(megaDownloadName(`${'a'.repeat(239)}\ud83d\ude00.mp4`)).toBe(`${'a'.repeat(239)}\ud83d.mp4`)
  })

  it('replaces consecutive control and directional characters with one space', () => {
    expect(megaDownloadName('scene\t\n\v\f\r\u200e\u200f\u202etake.mp4')).toBe('scene take.mp4')
    expect(megaDownloadName('scene\u200etake\r2.mp4')).toBe('scene take 2.mp4')
  })

  it('preserves safe names, Unicode and punctuation unrelated to the provider mapping', () => {
    for (const name of ['Handy slow test in OFS.mp4', 'Speed test.mp4', 'scene.roll.funscript', '映像 😀.mp4', 'Scene [1080p] (cut).webm', 'A; $(`B`).zip']) {
      expect(megaDownloadName(name)).toBe(name)
    }
  })
})

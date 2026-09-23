import { describe, expect, it } from 'vitest'
import { ScriptFolders } from './script-folders'

describe('script folder index', () => {
  it('matches names and axis/variant suffixes across roots, in stable folder order', () => {
    const folders = new ScriptFolders(new Map([
      ['/scripts/z', ['scene.roll.funscript', 'scene.alternative.pitch.funscript']],
      ['/videos', ['scene.funscript']],
      ['/scripts/a', ['scene (Less Vibration).FUNSCRIPT', 'scene_simple.funscript']],
      ['/scripts/unrelated', ['scene2.funscript', 'scene.jpg']],
    ]))
    expect(folders.forMedia('/videos/scene.mp4')).toEqual(['/scripts/a', '/scripts/z'])
    expect(folders.forMedia('/videos/scen.mp4')).toEqual([])
    expect(folders.forMedia('/videos/Scene.mp4')).toEqual([])
  })

  it('keeps dotted names and only matches zip names exactly', () => {
    const folders = new ScriptFolders(new Map([['/scripts', ['scene.part.zip', 'other.part.roll.funscript']]]))
    expect(folders.forMedia('/videos/scene.part.mkv')).toEqual(['/scripts'])
    expect(folders.forMedia('/videos/scene.mp4')).toEqual([])
    expect(folders.forMedia('/videos/other.part.mp4')).toEqual(['/scripts'])
  })
})

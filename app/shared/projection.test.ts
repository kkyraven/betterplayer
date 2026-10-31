import { describe, expect, it } from 'vitest'
import {
  detectProjection,
  FLAT,
  flatEye,
  needsLook,
  readContainerFacts,
  readPictureFacts,
  resolveProjection,
  worthProbing,
  type ContainerFacts,
  type PictureFacts,
  type Projection,
} from './projection'

const vr = (kind: Projection['kind'], layout: Projection['layout'], fov = 190): Projection => ({ kind, layout, fov, swapEyes: false })

describe('detectProjection', () => {
  it('reads VR180, 180VR, VR360, 360VR and degree tags', () => {
    expect(detectProjection('Beach VR180 SBS')).toEqual(vr('equirect180', 'sbs'))
    expect(detectProjection('Studio - Title [VR180]')).toEqual(vr('equirect180', 'sbs'))
    expect(detectProjection('scene_180VR_TB')).toEqual(vr('equirect180', 'ou'))
    expect(detectProjection('scene_VR360')).toEqual(vr('equirect360', 'mono'))
    expect(detectProjection('scene 360VR')).toEqual(vr('equirect360', 'mono'))
    expect(detectProjection('clip 180° LR')).toEqual(vr('equirect180', 'sbs'))
    expect(detectProjection('clip_360°_TB')).toEqual(vr('equirect360', 'ou'))
  })

  it('keeps a fisheye tag over a 180 tag', () => {
    expect(detectProjection('scene_MKX200_VR180')).toEqual(vr('fisheye', 'sbs', 200))
  })

  it.each([
    ['scene_LR_180', vr('equirect180', 'sbs')],
    ['scene_8K_180x180_3dh', vr('equirect180', 'sbs')],
    ['scene_360_TB', vr('equirect360', 'ou')],
    ['scene_360x180_3dv', vr('equirect360', 'ou')],
    ['scene_FISHEYE190_', vr('fisheye', 'sbs', 190)],
    ['scene_MKX200', vr('fisheye', 'sbs', 200)],
    ['scene_VRCA220', vr('fisheye', 'sbs', 220)],
    ['scene_RF52', vr('fisheye', 'sbs', 190)],
    ['vr_180', vr('equirect180', 'sbs')],
    ['scene_SBS', { ...FLAT, layout: 'sbs' }],
    ['my vr video', FLAT],
    ['scene_1080p', FLAT],
    ['', FLAT],
  ] as const)('%s', (name, expected) => {
    expect(detectProjection(name)).toEqual(expected)
  })
})

const pic = (lr: number, tb: number, wrap: number, corner = 1): PictureFacts => ({ lr, tb, wrap, corner, frames: 12 })
type Row = [id: string, name: string, size: string, container: ContainerFacts | null, picture: PictureFacts | null, expected: string]

const TABLE: Row[] = [
  ['M1', 'IMG_0001', '5760x2880', { stereo: 'sbs', sphere: 'equirect', cover: 0.5 }, null, 'equirect180 sbs / metadata'],
  ['M2', 'GS010012', '5376x2688', { stereo: 'mono', sphere: 'equirect' }, null, 'equirect360 mono / metadata'],
  ['M3', 'trip', '3840x3840', { stereo: 'ou', sphere: 'equirect' }, null, 'equirect360 ou / metadata'],
  ['M4', 'concert', '4096x2048', { sphere: 'equirect', stereo: 'sbs' }, null, 'equirect180 sbs / metadata'],
  ['M5', 'movie', '3840x1080', { stereo: 'sbs' }, null, 'flat sbs / metadata'],
  ['M6', 'movie', '1920x2160', { stereo: 'ou' }, null, 'flat ou / metadata'],
  ['M7', 'film', '3840x1080', { stereo: 'sbs', swap: true }, null, 'flat sbs swap / metadata'],
  ['M8', 'IMG_4321', '1920x1080', { stereo: 'views' }, null, 'flat / metadata'],
  ['M9', 'immersive', '4320x2160', { stereo: 'sbs', sphere: 'half' }, null, 'equirect180 sbs / metadata'],
  ['M10', 'immersive2', '4320x2160', { stereo: 'sbs', swap: true, sphere: 'half' }, null, 'equirect180 sbs swap / metadata'],
  ['M11', 'aiv', '4320x4320', { stereo: 'views', sphere: 'fisheye' }, null, 'fisheye mono 180 / metadata'],
  ['M12', 'yt', '3840x2560', { sphere: 'other' }, null, 'flat / none'],
  ['M13', 'Title_180_LR', '5760x2880', { stereo: 'mono' }, null, 'equirect180 sbs / name'],
  ['M14', 'Title_180_LR', '5760x2880', { sphere: 'equirect' }, null, 'equirect180 sbs / metadata'],
  ['M15', 'Title_LR', '3840x1920', { stereo: 'sbs' }, pic(0.9, 0.1, 4, 0.05), 'equirect180 sbs / metadata'],
  ['M16', 'clip', '4096x4096', { stereo: 'ou', swap: true }, null, 'flat ou swap / metadata'],
  ['N1', 'SLR_Studio_Title_8K_MKX200', '7680x3840', null, null, 'fisheye sbs 200 / name'],
  ['N2', 'Title_MKX220', '8000x4000', null, null, 'fisheye sbs 220 / name'],
  ['N3', 'Title_VRCA220_LR', '7680x3840', null, null, 'fisheye sbs 220 / name'],
  ['N4', 'Title_FISHEYE190', '8192x4096', null, null, 'fisheye sbs 190 / name'],
  ['N5', 'Title_RF52', '8192x4096', null, null, 'fisheye sbs 190 / name'],
  ['N6', 'Title_fisheye', '5760x2880', null, null, 'fisheye sbs 180 / name'],
  ['N7', 'Title_F180_LR', '5760x2880', null, null, 'fisheye sbs 180 / name'],
  ['N8', 'Studio_Title_6k_180x180_3dh', '6144x3072', null, null, 'equirect180 sbs / name'],
  ['N9', 'Title-180_LR', '5760x2880', null, null, 'equirect180 sbs / name'],
  ['N10', 'Title_8K_180_LR_60fps', '7680x3840', null, null, 'equirect180 sbs / name'],
  ['N11', 'Title_VR180', '5760x2880', null, null, 'equirect180 sbs / name'],
  ['N12', 'Title_180_TB', '4096x4096', null, null, 'equirect180 ou / name'],
  ['N13', 'Title_180_RL', '5760x2880', null, null, 'equirect180 sbs swap / name'],
  ['N14', 'Title_360_BT', '4096x4096', null, null, 'equirect360 ou swap / name'],
  ['N15', 'Title_360_mono', '3840x1920', null, null, 'equirect360 mono / name'],
  ['N16', 'Title_180_mono', '2880x2880', null, null, 'equirect180 mono / name'],
  ['N17', 'Title_360', '5760x5760', null, null, 'equirect360 ou / name'],
  ['N18', 'Title_360', '3840x1920', null, null, 'equirect360 mono / name'],
  ['N19', 'Title_180', '4096x4096', null, null, 'equirect180 ou / name'],
  ['N20', 'Title_OverUnder_180', '4096x4096', null, null, 'equirect180 ou / name'],
  ['N21', 'Title_180_3dv', '4096x4096', null, null, 'equirect180 ou / name'],
  ['N22', 'Title_SBS', '3840x1080', null, null, 'flat sbs / name'],
  ['N23', 'Title_3D_HSBS', '1920x1080', null, null, 'flat sbs / name'],
  ['N24', 'Avatar.2009.3D.HOU.1080p', '1920x1080', null, null, 'flat ou / name'],
  ['N25', '3D.Movie.2010.1080p.BluRay.Half-SBS', '1920x1080', null, null, 'flat sbs / name'],
  ['N26', 'Xbox 360 review', '1920x1080', null, null, 'flat / none'],
  ['N27', 'Halo 360 noscope', '3840x2160', null, null, 'flat / none'],
  ['N28', 'Vrai ou faux', '1920x1080', null, null, 'flat / none'],
  ['N29', 'Title_VR360', '1920x1080', null, null, 'equirect360 mono / name'],
  ['N30', 'clip_alpha_MKX200', '7680x3840', null, null, 'fisheye sbs 200 / name'],
  ['N31', 'naughty_180°_LR', '5760x2880', null, null, 'equirect180 sbs / name'],
  ['N32', 'Title_LR', '5760x2880', null, null, 'equirect180 sbs / name'],
  ['N36', 'Title_LR', '3840x1080', null, null, 'flat sbs / name'],
  ['N33', 'vr_180', '0x0', null, null, 'equirect180 sbs / name'],
  ['N34', 'my vr video', '1920x1080', null, null, 'flat / none'],
  ['N35', 'Title_EAC360', '3840x2160', null, null, 'flat / none'],
  ['S1', 'download (3)', '5760x2880', null, null, 'flat / none'],
  ['S2', 'video', '4096x4096', null, null, 'flat / none'],
  ['S3', 'video', '2880x5760', null, null, 'flat / none'],
  ['S4', 'Stranger.Things.S01E01.2160p', '3840x1920', null, null, 'flat / none'],
  ['S5', 'insta', '1080x1080', null, null, 'flat / none'],
  ['S6', 'game capture', '5120x1440', null, null, 'flat / none'],
  ['S7', 'cam', '4096x2160', null, null, 'flat / none'],
  ['S8', 'video', '1920x960', null, null, 'flat / none'],
  ['S9', 'pano', '7680x1920', null, null, 'flat / none'],
  ['P1', 'Stranger.Things.S01E01.2160p', '3840x1920', null, pic(0.27, 0.3, 101), 'flat / none'],
  ['P2', 'video', '1920x960', null, pic(0.98, 0.04, 3.2), 'equirect180 sbs / picture'],
  ['P3', 'download', '7680x3840', null, pic(0.86, 0.02, 1.0, 0.03), 'equirect180 sbs / picture'],
  ['P4', 'download', '3840x1920', null, pic(0.02, 0.16, 0.73), 'equirect360 mono / picture'],
  ['P5', 'download', '4096x4096', null, pic(0.06, 0.96, 4.8), 'flat ou / picture'],
  ['P6', 'download', '4096x4096', null, pic(-0.11, 0.98, 0.48), 'equirect360 ou / picture'],
  ['P11', 'download', '7680x1920', null, pic(0.9, 0.1, 1.1), 'equirect360 sbs / picture'],
  ['P12', 'download', '1920x1080', null, pic(0.02, 0.16, 0.9), 'flat / none'],
  ['P7', '3dmovie', '3840x1080', null, pic(1, 0.66, 101), 'flat sbs / picture'],
  ['P8', 'game capture', '5120x1440', null, pic(0.3, 0.2, 90), 'flat / none'],
  ['P9', 'clip', '1920x2160', null, pic(0.1, 0.95, 80), 'flat ou / picture'],
  ['P10', 'Title_180_LR', '5760x2880', null, pic(0.1, 0.9, 5), 'equirect180 sbs / name'],
]

const summary = ({ projection: p, source }: ReturnType<typeof resolveProjection>) =>
  [p.kind, p.kind === 'flat' && p.layout === 'mono' ? '' : p.layout, p.kind === 'fisheye' ? String(p.fov) : '', p.swapEyes ? 'swap' : ''].filter(Boolean).join(' ') + ` / ${source}`

describe('resolveProjection', () => {
  it.each(TABLE)('%s %s %s', (_id, name, size, container, picture, expected) => {
    const [width, height] = size.split('x').map(Number) as [number, number]
    expect(summary(resolveProjection({ name, width, height, container, picture }))).toBe(expected)
  })

  it('puts the per-video pick above everything', () => {
    const user = vr('equirect360', 'ou')
    expect(resolveProjection({ name: 'Title_180_LR', width: 5760, height: 2880, container: { sphere: 'fisheye' }, user })).toEqual({ projection: user, source: 'user' })
  })

  it('ignores a picture with no textured frame, or edges it could not read', () => {
    expect(summary(resolveProjection({ name: 'download', width: 3840, height: 1920, picture: { ...pic(0.95, 0.1, 3), frames: 0 } }))).toBe('flat / none')
    expect(summary(resolveProjection({ name: 'download', width: 3840, height: 1920, picture: { lr: 0.1, tb: 0.1, wrap: null, corner: null, frames: 20 } }))).toBe('flat / none')
  })

  it('keeps half-size 3D films flat: a 16:9 half side by side eye is not square', () => {
    expect(summary(resolveProjection({ name: 'film', width: 1920, height: 1080, picture: pic(0.95, 0.1, 50) }))).toBe('flat sbs / picture')
  })
})

describe('needsLook and worthProbing', () => {
  it('looks only where nothing decided, on a shape the check reads', () => {
    expect(needsLook({ name: 'download (3)', width: 5760, height: 2880 })).toBe(true)
    expect(needsLook({ name: 'Title_LR', width: 5760, height: 2880 })).toBe(false)
    expect(needsLook({ name: 'game capture', width: 5120, height: 1440 })).toBe(true)
    expect(needsLook({ name: 'Title_180_LR', width: 5760, height: 2880 })).toBe(false)
    expect(needsLook({ name: 'IMG_0001', width: 5760, height: 2880, container: { sphere: 'equirect', cover: 0.5 } })).toBe(false)
    expect(needsLook({ name: 'cam', width: 3840, height: 2160 })).toBe(false)
    expect(needsLook({ name: 'video', width: 1280, height: 640 })).toBe(false)
  })

  it('probes older rows that could be VR', () => {
    expect(worthProbing('GS010012', 5376, 2688)).toBe(true)
    expect(worthProbing('cam', 3840, 2160)).toBe(true)
    expect(worthProbing('clip_VR180', 1920, 1080)).toBe(true)
    expect(worthProbing('holiday', 1920, 1080)).toBe(false)
  })
})

describe('stored facts', () => {
  it('reads what was stored and tells never captured from nothing there', () => {
    expect(readContainerFacts('')).toBeUndefined()
    expect(readContainerFacts('not json')).toBeUndefined()
    expect(readContainerFacts('{}')).toEqual({})
    expect(readContainerFacts(JSON.stringify({ sphere: 'equirect', cover: 0.5, stereo: 'sbs', swap: true, junk: 1 }))).toEqual({ sphere: 'equirect', cover: 0.5, stereo: 'sbs', swap: true })
    expect(readContainerFacts(JSON.stringify({ sphere: 'cylinder', stereo: 'anaglyph', cover: 4 }))).toEqual({})
    expect(readPictureFacts('')).toBeUndefined()
    expect(readPictureFacts('{"lr":0.9}')).toBeUndefined()
    expect(readPictureFacts(JSON.stringify({ lr: 0.9, tb: 0.1, wrap: null, corner: 0.05, frames: 20 }))).toEqual({ lr: 0.9, tb: 0.1, wrap: null, corner: 0.05, frames: 20 })
  })

  it('reads a name that is an Object property as a plain word', () => {
    expect(detectProjection('constructor toString __proto__')).toEqual(FLAT)
  })
})

describe('flatEye', () => {
  const sbs = { ...FLAT, layout: 'sbs' } as const
  const ou = { ...FLAT, layout: 'ou' } as const
  it('halves full 3D and shows half-size 3D at the whole frame', () => {
    expect(flatEye(sbs, 3840, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(flatEye(sbs, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(flatEye(ou, 1920, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(flatEye(ou, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(flatEye(FLAT, 1920, 800)).toEqual({ width: 1920, height: 800 })
  })

  it('keeps a full 4:3 side by side and a full scope over under', () => {
    expect(flatEye(sbs, 2880, 1080)).toEqual({ width: 1440, height: 1080 })
    expect(flatEye(ou, 1920, 1608)).toEqual({ width: 1920, height: 804 })
  })
})

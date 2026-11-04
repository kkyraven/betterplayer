import { describe, expect, it, vi } from 'vitest'
import { containerFacts, probe } from './probe'
import { runTool } from './tools'

vi.mock('./tools', () => ({ runTool: vi.fn() }))

const sd3d = (type: string, inverted = 0) => ({ side_data_type: 'Stereo 3D', type, inverted, view: 'packed', primary_eye: 'none', baseline: 0, horizontal_disparity_adjustment: '0/1', horizontal_field_of_view: '0/1' })
const sphere = (projection: string, extra: Record<string, number> = {}) => ({ side_data_type: 'Spherical Mapping', projection, ...extra, yaw: 0, pitch: 0, roll: 0 })
const stream = (width: number, height: number, sideData: object[] | null, stereoMode?: string) => ({
  codec_type: 'video',
  width,
  height,
  ...(sideData ? { side_data_list: sideData } : {}),
  ...(stereoMode ? { tags: { stereo_mode: stereoMode } } : {}),
})

const FIXTURES: [file: string, stream: Record<string, unknown>, facts: object][] = [
  ['g180sbs.mp4', stream(512, 256, [sd3d('side by side'), sphere('tiled equirectangular', { bound_left: 257, bound_top: 0, bound_right: 255, bound_bottom: 0 })]), { stereo: 'sbs', sphere: 'equirect', cover: 0.5 }],
  ['g360mono.mp4', stream(512, 256, [sd3d('2D'), sphere('equirectangular')]), { stereo: 'mono', sphere: 'equirect' }],
  ['g360tb.mkv', stream(256, 256, [sd3d('top and bottom'), sphere('equirectangular')], 'top_bottom'), { stereo: 'ou', sphere: 'equirect' }],
  ['sbs.mkv', stream(256, 128, [sd3d('side by side')], 'left_right'), { stereo: 'sbs' }],
  ['sm_top_bottom.mkv', stream(512, 256, [sd3d('top and bottom')], 'top_bottom'), { stereo: 'ou' }],
  ['sm_right_left.mkv', stream(512, 256, [sd3d('side by side', 1)], 'right_left'), { stereo: 'sbs', swap: true }],
  ['sm_bottom_top.mkv', stream(512, 256, [sd3d('top and bottom', 1)], 'bottom_top'), { stereo: 'ou', swap: true }],
  ['sm_mono.mkv', stream(512, 256, [sd3d('2D')]), { stereo: 'mono' }],
  ['apmpspatial.mp4', stream(512, 256, [{ ...sd3d('unspecified'), horizontal_field_of_view: '63400/1000' }]), { stereo: 'views' }],
  ['apmp180sbs.mp4', stream(512, 256, [sd3d('side by side'), sphere('half equirectangular')]), { stereo: 'sbs', sphere: 'half' }],
  ['apmpswap.mp4', stream(512, 256, [sd3d('side by side', 1), sphere('half equirectangular')]), { stereo: 'sbs', swap: true, sphere: 'half' }],
  ['apmpfish.mp4', stream(512, 256, [sd3d('unspecified'), sphere('fisheye')]), { stereo: 'views', sphere: 'fisheye' }],
  ['gcube.mp4', stream(512, 256, [sphere('cubemap', { padding: 0 })]), { sphere: 'other' }],
  ['st3donly.mp4', stream(512, 256, [sd3d('side by side')]), { stereo: 'sbs' }],
  ['base2x1.mp4', stream(512, 256, null), {}],
]

describe('containerFacts', () => {
  it.each(FIXTURES)('%s', (_file, s, facts) => {
    expect(containerFacts(s)).toEqual(facts)
  })

  it('falls back to the Matroska tag when an older ffprobe gives no side data', () => {
    expect(containerFacts(stream(512, 256, null, 'right_left'))).toEqual({ stereo: 'sbs', swap: true })
    expect(containerFacts(stream(512, 256, null, 'anaglyph_cyan_red'))).toEqual({})
  })
})

describe('probe', () => {
  it('reads the video stream, not the cover image listed before it', async () => {
    const cover = { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } }
    const video = { ...FIXTURES[0]![1], codec_name: 'hevc' }
    vi.mocked(runTool).mockResolvedValue(JSON.stringify({ streams: [cover, { codec_type: 'audio' }, video], format: { duration: '61.5' } }))
    expect(await probe('clip.mp4')).toEqual({ durationMs: 61_500, width: 512, height: 256, codec: 'hevc', vr: { stereo: 'sbs', sphere: 'equirect', cover: 0.5 }, chapters: [] })
  })

  it('gives empty facts for a file with no video', async () => {
    vi.mocked(runTool).mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '3' } }))
    expect(await probe('song.mp4')).toEqual({ durationMs: 3000, width: 0, height: 0, codec: '', vr: {}, chapters: [] })
  })

  it('reads chapters as marks, without empty ones or one spanning the video', async () => {
    const chapter = (start: string, end: string, title?: string) => ({ id: 0, time_base: '1/1000', start_time: start, end_time: end, ...(title ? { tags: { title } } : {}) })
    vi.mocked(runTool).mockResolvedValue(JSON.stringify({
      streams: [], format: { duration: '120' },
      chapters: [chapter('0.000000', '30.500000', 'Intro'), chapter('30.500000', '30.500000', 'Empty'), chapter('30.500000', '120.000000')],
    }))
    expect((await probe('film.mkv')).chapters).toEqual([{ name: 'Intro', startMs: 0, endMs: 30_500 }, { name: '', startMs: 30_500, endMs: 120_000 }])
    vi.mocked(runTool).mockResolvedValue(JSON.stringify({ streams: [], format: { duration: '120' }, chapters: [chapter('0', '119.6', 'All')] }))
    expect((await probe('film.mkv')).chapters).toEqual([])
  })
})

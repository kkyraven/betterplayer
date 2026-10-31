import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTrackAxes } from '@shared/tracking'
import { Library } from './index'

vi.mock('electron', () => ({ net: {}, ipcMain: { on: vi.fn(), removeListener: vi.fn() }, WebContentsView: vi.fn() }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./thumbs', () => ({
  ThumbQueue: class {
    file() { return '' }
    pending() { return 0 }
    enqueue() {}
    async remove() {}
  },
}))

let directory: string
let library: Library

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bp-video-overrides-'))
  library = new Library({ dataDir: directory, enginePath: join(directory, 'unused-engine.js'), modelsDir: join(directory, 'models') })
})

afterEach(async () => {
  library.close()
  await rm(directory, { recursive: true, force: true })
})

describe('reset all overrides', () => {
  it('clears picks, tuning, the crosshair, the music mark and sensitivity everywhere and retires legacy tables, keeping the rest', () => {
    const axes = defaultTrackAxes()
    const zone = { x: 0.1, y: 0.4, w: 0.1, h: 0.2 }
    const zones = { enabled: true, zones: [] }
    const keys = { legacy: '/v/legacy.mp4', picked: '/v/picked.mp4', hero: '/v/hero.mp4', emptied: '/v/emptied.mp4', page: 'https://site.fictional/watch/1', clean: '/v/clean.mp4' }
    library.setVideoSettings(keys.legacy, { globalOffsetMs: 0, axes: {}, variants: { L0: 'slow' }, position: 9000, tracking: { axes, sensitivity: 1, region: null, pace: 0.4 } })
    library.setVideoSettings(keys.picked, { globalOffsetMs: 120, axes: {}, tracking: { own: { L0: { source: 'beat' } }, on: false, notMusic: true, axes, region: null } })
    library.setVideoSettings(keys.hero, { globalOffsetMs: 0, axes: {}, tracking: { own: { L2: { max: 0.5 } }, region: null, heroZone: zone, heroDirection: 'left-to-right', zones, heroFileStamp: '1024:1' } })
    library.setVideoSettings(keys.emptied, { globalOffsetMs: 0, axes: {}, tracking: { axes, sensitivity: 1.2, region: null } })
    library.setVideoSettings(keys.page, { globalOffsetMs: 0, axes: {}, position: 5000, tracking: { own: { L0: { source: 'faptap' } }, region: null } })
    library.setVideoSettings(keys.clean, { globalOffsetMs: 0, axes: {}, tracking: { own: {}, region: null, pace: 0.3 } })

    expect(library.overrideCount()).toBe(5)
    expect(library.resetOverrides()).toBe(5)
    expect(library.overrideCount()).toBe(0)

    expect(library.videoSettings(keys.legacy)).toEqual({ globalOffsetMs: 0, axes: {}, variants: { L0: 'slow' }, position: 9000, tracking: { region: null, pace: 0.4, axes, own: {} } })
    expect(library.videoSettings(keys.picked)).toEqual({ globalOffsetMs: 120, axes: {} })
    expect(library.videoSettings(keys.hero)?.tracking).toEqual({ region: null, heroZone: zone, heroDirection: 'left-to-right', zones, heroFileStamp: '1024:1', own: {} })
    expect(library.videoSettings(keys.emptied)).toBeNull()
    expect(library.videoSettings(keys.page)).toEqual({ globalOffsetMs: 0, axes: {}, position: 5000 })
    expect(library.videoSettings(keys.clean)?.tracking).toEqual({ own: {}, region: null, pace: 0.3 })
    expect(library.resetOverrides()).toBe(0)
  })
})

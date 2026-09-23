import type { MediaIndexRow, MediaRow } from '@shared/library'
import type { Projection, ProjectionKind } from '@shared/projection'

interface DeoListItem {
  title: string
  videoLength: number
  thumbnailUrl: string
  video_url: string
}

export interface DeoIndex {
  scenes: { name: string; list: DeoListItem[] }[]
}

export interface DeoScene {
  id: number
  title: string
  videoLength: number
  thumbnailUrl: string
  is3d: boolean
  screenType: string
  stereoMode: string
  encodings: { name: string; videoSources: { resolution: number; url: string }[] }[]
  skipIntro: number
}

const SCREEN_TYPES: Record<ProjectionKind, string> = {
  flat: 'flat',
  equirect180: 'dome',
  equirect360: 'sphere',
  fisheye: 'fisheye',
}

function screenType(projection: Projection): string {
  if (projection.kind === 'fisheye' && projection.fov >= 200) return 'mkx200'
  return SCREEN_TYPES[projection.kind]
}

const STEREO_MODES = { mono: 'off', sbs: 'sbs', ou: 'tb' } as const

export function deoIndex(rows: MediaIndexRow[], base: string): DeoIndex {
  const list = rows.map((row) => ({
    title: row.title,
    videoLength: Math.round(row.durationMs / 1000),
    thumbnailUrl: `${base}/thumb/${row.id}`,
    video_url: `${base}/deovr/${row.id}`,
  }))
  return { scenes: [{ name: 'Better Player', list }] }
}

export function deoScene(row: MediaRow, projection: Projection, base: string): DeoScene {
  return {
    id: row.id,
    title: row.title,
    videoLength: Math.round(row.durationMs / 1000),
    thumbnailUrl: `${base}/thumb/${row.id}`,
    is3d: projection.layout !== 'mono',
    screenType: screenType(projection),
    stereoMode: STEREO_MODES[projection.layout],
    encodings: [{ name: 'h264', videoSources: [{ resolution: row.height, url: `${base}/media/${row.id}` }] }],
    skipIntro: 0,
  }
}

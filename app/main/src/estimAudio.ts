import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pickEstimAudio } from '@shared/estimAudio'
import { isAudioPath, isVideoPath } from '@shared/ipc'

const MAX_FOLDERS = 16

const list = (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => [])

export async function findEstimAudio(video: string): Promise<string | null> {
  if (isAudioPath(video)) return null
  const dir = dirname(video)
  const entries = await list(dir)
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
  const videos = files.filter(isVideoPath).map((name) => join(dir, name))
  const audio = files.filter(isAudioPath).map((name) => join(dir, name))
  const own = basename(video).toLowerCase()
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  if (!videos.some((v) => basename(v).toLowerCase() !== own) && folders.length <= MAX_FOLDERS) {
    const below = await Promise.all(folders.map(async (f) => ({ dir: join(dir, f.name), entries: await list(join(dir, f.name)) })))
    for (const folder of below) {
      const inside = folder.entries.filter((e) => e.isFile())
      if (inside.some((e) => isVideoPath(e.name))) continue
      audio.push(...inside.filter((e) => isAudioPath(e.name)).map((e) => join(folder.dir, e.name)))
    }
  }
  return pickEstimAudio(video, audio, videos)
}

import { t } from '../../i18n'
import type { Projection } from '@shared/projection'
import type { ServerKind } from '@shared/remote'
import type { ImportedPerformer } from '@shared/search'
import type { ServerRoot } from '../db'
import { HereSphereAdapter } from './heresphere'
import { StashAdapter } from './stash'

export interface RemoteScene {
  key: string
  title: string
  folder: string
  addedAt: number
  mtime: number
  size: number
  durationMs: number
  width: number
  height: number
  codec: string
  projection: Projection | null
  rating: number
  favourite?: boolean
  tags: string[]
  description: string
  performers: ImportedPerformer[]
  filename: string
  stream: string
  scripts: { name: string; url: string }[]
  thumb: string | null
  preview?: { sprite: string | null; vtt: string | null; video: string | null }
}

export interface RemoteEntry {
  key: string
  stamp: string
  scene: RemoteScene | null
}

export interface RemoteGroup {
  key: string
  name: string
  sceneKeys: string[]
}

export interface RemoteWrite {
  rating: number
  favourite: boolean
  tags: string[]
}

export interface Adapter {
  readonly kind: ServerKind
  readonly headers: Record<string, string>
  probe(): Promise<string>
  scenes(known: Map<string, string>, total: (n: number) => void): AsyncGenerator<RemoteEntry[]>
  writeBack(key: string, write: RemoteWrite): Promise<void>
}

export function makeAdapter(root: ServerRoot): Adapter {
  return root.kind === 'stash' ? new StashAdapter(root) : new HereSphereAdapter(root)
}

export async function detectServer(root: Omit<ServerRoot, 'id' | 'kind'>): Promise<{ kind: ServerKind; name: string }> {
  const errors: string[] = []
  for (const kind of ['stash', 'heresphere'] as const) {
    try {
      const name = await makeAdapter({ ...root, id: 0, kind }).probe()
      return { kind, name }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  throw new Error(errors.find((m) => m === t('library.server.error.signInFailed') || m === t('library.server.error.signInRequired') || /sign in|api key|password/i.test(m)) ?? errors[errors.length - 1] ?? t('library.server.error.notFound'))
}

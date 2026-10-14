import type { DownloadBatch } from '@shared/downloads'
import { invoke } from '@/ipc'
import { useBrowser } from '@/state/browser'
import { useLibrary } from '@/state/library'
import { useMatcher } from '@/state/matcher'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'
import { topicTab } from './topicTab'

export async function openBatchTopic(batch: DownloadBatch) {
  const tab = topicTab(batch, useBrowser.getState().tabs)
  if (tab !== null) await useBrowser.getState().activate(tab)
  else await useBrowser.getState().open(batch.topicUrl)
  useUi.getState().setScreen('browser')
}

export function openBatchLibrary(batch: DownloadBatch) {
  useLibrary.getState().setSearch('')
  useLibrary.getState().setFilters({})
  useLibrary.getState().setFolder({ rootId: batch.destination.rootId, folder: batch.destination.relativePath })
  useUi.getState().setScreen('library')
}

export async function playMedia(mediaId: number) {
  const detail = await invoke('library:media', mediaId)
  if (detail) await usePlayer.getState().open(detail.path)
}

export function matchVideo() {
  useUi.getState().setScreen('utilities')
  void useMatcher.getState().scan()
}

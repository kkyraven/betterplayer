import { Check, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDownloads } from '@/state/downloads'
import { useLibrary } from '@/state/library'
import { useT } from '@/state/i18n'
import type { DownloadDestination } from '@shared/downloads'
import type { LibraryRoot } from '@shared/library'

export function rootName(root: LibraryRoot): string {
  return root.name || root.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root.path
}

export function DestinationPicker({ onChoose }: { onChoose?: (destination: DownloadDestination) => void }) {
  const t = useT()
  const roots = useLibrary((state) => state.roots)
  const destination = useDownloads((state) => state.destination)
  const saved = useDownloads((state) => state.defaultDestination)
  const setDestination = useDownloads((state) => state.setDestination)
  const setDefault = useDownloads((state) => state.setDefault)
  const folders = roots.filter((root) => root.kind === 'folder')
  const selected = folders.find((root) => root.id === destination?.rootId)
  const choose = async (rootId: number) => {
    if (!folders.some((root) => root.id === rootId)) return
    const next = { rootId, relativePath: '' }
    await setDestination(next)
    onChoose?.(next)
  }
  const add = async () => {
    try {
      const added = await useLibrary.getState().addRoot()
      const folder = added.find((root) => root.kind === 'folder')
      if (folder) {
        const next = { rootId: folder.id, relativePath: '' }
        await setDestination(next)
        onChoose?.(next)
      }
    } catch (error) { useDownloads.setState({ error: error instanceof Error ? error.message : String(error) }) }
  }
  const isDefault = selected && saved?.rootId === selected.id && saved.relativePath === (destination?.relativePath ?? '')
  return (
    <div className="download-destination">
      <label className="field"><span className="field-label">{t('downloads.library')}</span>
        <select className="input" value={selected?.id ?? ''} onChange={(event) => void choose(Number(event.target.value))}>
          <option value="" disabled>{t('downloads.chooseFolder')}</option>
          {folders.map((root) => <option key={root.id} value={root.id}>{rootName(root)}</option>)}
        </select>
      </label>
      <div className="download-destination-actions">
        <Button variant="ghost" onClick={() => void add()}><FolderPlus />{t('downloads.addFolder')}</Button>
        {selected && <Button variant="ghost" disabled={!!isDefault} onClick={() => destination && void setDefault(destination)}>{isDefault && <Check />}{t(isDefault ? 'common.default' : 'downloads.setDefault')}</Button>}
      </div>
    </div>
  )
}

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { EyeOff, FolderInput, ListPlus, Pin, PinOff, Plus, Tag, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FolderNode } from '@shared/library'
import { isPlaylist } from '@shared/library'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Prompt } from '@/components/ui/Prompt'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSelect } from '@/state/select'

export function SelectBar() {
  const on = useSelect((s) => s.on)
  return on ? <Bar /> : null
}

function Bar() {
  const t = useT()
  const ids = useSelect((s) => s.ids)
  const setAll = useSelect((s) => s.setAll)
  const before = useSelect((s) => s.before)
  const undoAll = useSelect((s) => s.undoAll)
  const clear = useSelect((s) => s.clear)
  const total = useLibrary((s) => s.total)
  const rows = useLibrary((s) => s.rows)
  const folders = useLibrary((s) => s.folders)
  const roots = useLibrary((s) => s.roots)
  const allIds = useLibrary((s) => s.allIds)
  const setPinned = useLibrary((s) => s.setPinned)
  const setHidden = useLibrary((s) => s.setHidden)
  const moveToFolder = useLibrary((s) => s.moveToFolder)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const tags = useLibrary((s) => s.tags)
  const addTag = useLibrary((s) => s.addTag)
  const [naming, setNaming] = useState(false)
  const [tagging, setTagging] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clear])

  const list = useMemo(() => [...ids], [ids])
  const pinnedById = useMemo(() => new Map(rows.flatMap((r) => (isPlaylist(r) ? [] : [[r.id, r.pinned] as const]))), [rows])
  const allPinned = list.length > 0 && list.every((id) => pinnedById.get(id))
  const none = list.length === 0
  const targets = useMemo(() => flatten(folders.filter((node) => roots.find((r) => r.id === node.rootId)?.kind === 'folder')), [folders, roots])

  return (
    <div className="select-bar" role="toolbar" aria-label={t('library.select.toolbar')}>
      <span className="count">
        {t('library.select.selected', { count: list.length })}
      </span>
      {before ? (
        <Button variant="ghost" onClick={undoAll}>
          <Undo2 />
          {t('common.undo')}
        </Button>
      ) : (
        list.length < total && (
          <Button variant="ghost" onClick={() => void allIds().then(setAll)}>
            {t('library.select.all', { count: total })}
          </Button>
        )
      )}
      <div className="spacer" />
      <Button disabled={none} onClick={() => void setPinned(list, !allPinned)}>
        {allPinned ? <PinOff /> : <Pin />}
        {allPinned ? t('library.select.unpin') : t('library.select.pinToTop')}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button disabled={none || targets.length === 0}>
            <FolderInput />
            {t('library.select.moveToFolder')}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu menu-folders" align="end" side="top" sideOffset={6}>
            {targets.map(({ node, depth }) => (
              <DropdownMenu.Item
                key={`${node.rootId}:${node.folder}`}
                className="item"
                style={{ paddingLeft: 8 + depth * 14 }}
                onSelect={() => void moveToFolder(list, { rootId: node.rootId, folder: node.folder }).then(clear)}
              >
                {node.name}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button disabled={none} onClick={() => setNaming(true)}>
        <ListPlus />
        {t('library.playlist.new')}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button disabled={none}>
            <Tag />
            {t('library.tag.add')}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" side="top" sideOffset={6}>
            {tags.map(({ name }) => (
              <DropdownMenu.Item key={name} className="item" onSelect={() => void addTag(list, name)}>
                {name}
              </DropdownMenu.Item>
            ))}
            {tags.length > 0 && <DropdownMenu.Separator className="sep" />}
            <DropdownMenu.Item className="item" onSelect={() => setTagging(true)}>
              <Plus />
              {t('library.tag.new')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button disabled={none} className="btn-danger" onClick={() => void setHidden(list, true).then(clear)}>
        <EyeOff />
        {t('library.folder.excludeFromLibrary')}
      </Button>
      <span className="sepv" />
      <IconButton label={t('common.done')} onClick={clear}>
        <X />
      </IconButton>
      <Prompt
        open={naming}
        onOpenChange={setNaming}
        title={t('library.select.newPlaylistTitle', { count: list.length })}
        placeholder={t('common.name')}
        confirmLabel={t('common.create')}
        onConfirm={(name) => void createPlaylist(name).then((p) => addToPlaylist(p.id, list))}
      />
      <Prompt
        open={tagging}
        onOpenChange={setTagging}
        title={t('library.select.tagTitle', { count: list.length })}
        placeholder={t('library.tag.placeholder')}
        suggestions={tags.map((tag) => tag.name)}
        confirmLabel={t('library.tag.add')}
        onConfirm={(tag) => void addTag(list, tag)}
      />
    </div>
  )
}

function flatten(nodes: FolderNode[], depth = 0): { node: FolderNode; depth: number }[] {
  return nodes.flatMap((node) => (node.excluded ? [] : [{ node, depth }, ...flatten(node.children, depth + 1)]))
}

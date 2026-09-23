import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowDown, ArrowUp, Ellipsis, ExternalLink, EyeOff, FolderOpen, Pencil, PencilRuler, Pin, PinOff, Tag, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { create } from 'zustand'
import { isPlaylist, type MediaRow } from '@shared/library'
import { isUrl, serverPage } from '@shared/remote'
import { TagPicker } from '@/components/media/TagPicker'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { electron, REVEAL_LABEL } from '@/node'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { canReorderPlaylist, movePlaylistRow } from './playlistDrag'
import '@/components/ui/Prompt.css'

const useMediaMenu = create<{ id: number | null; rect: DOMRect | null; anchor: HTMLElement | null }>(() => ({ id: null, rect: null, anchor: null }))
export const openMediaMenu = (row: MediaRow, e: MouseEvent<HTMLButtonElement>) => useMediaMenu.setState({ id: row.id, rect: e.currentTarget.getBoundingClientRect(), anchor: e.currentTarget })
export const openMediaContextMenu = (e: MouseEvent<HTMLDivElement>, row: MediaRow) => {
  e.preventDefault()
  e.stopPropagation()
  useMediaMenu.setState({ id: row.id, rect: new DOMRect(e.clientX, e.clientY, 0, 0), anchor: e.currentTarget })
}
const closeMenu = () => useMediaMenu.setState({ id: null })
const useRenameMedia = create<{ row: MediaRow | null }>(() => ({ row: null }))
export const renameMedia = (row: MediaRow) => useRenameMedia.setState({ row })

export function MediaMenuButton({ row }: { row: MediaRow }) {
  const t = useT()
  return (
    <IconButton label={t('library.options', { name: row.title })} size="sm" aria-haspopup="menu" onClick={(e) => openMediaMenu(row, e)}>
      <Ellipsis />
    </IconButton>
  )
}

export function MediaMenu() {
  const t = useT()
  const id = useMediaMenu((s) => s.id)
  const rect = useMediaMenu((s) => s.rect)
  const row = useLibrary((s) => (id === null ? null : (s.rows.find((r): r is MediaRow => !isPlaylist(r) && r.id === id) ?? s.continueRows.find((r) => r.id === id) ?? (s.detail?.id === id ? s.detail : null))))
  const tags = useLibrary((s) => s.tags)
  const playlistId = useLibrary(s => s.playlistId)
  const reorderable = useLibrary(canReorderPlaylist)
  const position = useLibrary(s => s.rows.findIndex(r => !isPlaylist(r) && r.id === id))
  const total = useLibrary(s => s.total)
  const [tagging, setTagging] = useState<{ id: number; tags: string[]; rect: DOMRect; anchor: HTMLElement | null } | null>(null)
  const openingDialog = useRef(false)
  const rename = useRenameMedia()
  const editing = rename.row
  useEffect(() => () => {
    useMediaMenu.setState({ id: null, rect: null, anchor: null })
    useRenameMedia.setState({ row: null })
  }, [])
  const tagEdit = useLibrary((s) => tagging ? s.tagEdits[tagging.id] : undefined)
  const taggingRow = useLibrary((s) => tagging ? s.rows.find((r): r is MediaRow => !isPlaylist(r) && r.id === tagging.id) ?? s.continueRows.find((r) => r.id === tagging.id) ?? (s.detail?.id === tagging.id ? s.detail : null) : null)
  const selectedTags = tagEdit && !tagEdit.error ? tagEdit.tags : taggingRow?.tags ?? tagEdit?.tags ?? tagging?.tags ?? []
  const tagError = tagEdit?.error && selectedTags.length === tagEdit.tags.length && selectedTags.every((tag) => tagEdit.tags.includes(tag))
  const changeTags = async (next: string[]) => {
    if (!tagging) return
    setTagging((current) => current && { ...current, tags: next })
    await useLibrary.getState().setTags(tagging.id, next)
  }

  return (
    <>
      <DropdownMenu.Root open={row !== null} onOpenChange={(open) => !open && closeMenu()}>
        <DropdownMenu.Trigger asChild>
          <span className="menu-anchor" style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined} aria-hidden />
        </DropdownMenu.Trigger>
        {row && (
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="menu"
              align={rect?.width === 0 ? 'start' : 'end'}
              sideOffset={rect?.width === 0 ? 0 : 4}
              onCloseAutoFocus={(e) => {
                e.preventDefault()
                if (!openingDialog.current) useMediaMenu.getState().anchor?.focus()
                openingDialog.current = false
              }}
            >
              <DropdownMenu.Item className="item" onSelect={() => {
                openingDialog.current = true
                renameMedia(row)
              }}>
                <Pencil />
                {t('common.rename')}
              </DropdownMenu.Item>
              {isUrl(row.path) ? (
                serverPage(row.path) && (
                  <DropdownMenu.Item className="item" onSelect={() => void electron.shell.openExternal(serverPage(row.path) ?? '')}>
                    <ExternalLink />
                    {t('library.menu.openInStash')}
                  </DropdownMenu.Item>
                )
              ) : (
                <DropdownMenu.Item className="item" onSelect={() => electron.shell.showItemInFolder(row.path)}>
                  <FolderOpen />
                  {t(REVEAL_LABEL)}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item className="item" onSelect={() => {
                if (!rect) return
                openingDialog.current = true
                setTagging({ id: row.id, tags: row.tags, rect, anchor: useMediaMenu.getState().anchor })
              }}>
                <Tag />
                {t('library.sidebar.tags')}
              </DropdownMenu.Item>
              {!isUrl(row.path) && (
                <DropdownMenu.Item className="item" onSelect={() => void useEditor.getState().openEditor(row.path)}>
                  <PencilRuler />
                  {t('library.menu.openInEditor')}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="sep" />
              {playlistId !== null && <>
                <DropdownMenu.Item className="item" disabled={!reorderable || position <= 0} onSelect={() => void movePlaylistRow(row, -1)}><ArrowUp />{t('library.playlist.moveEarlier')}</DropdownMenu.Item>
                <DropdownMenu.Item className="item" disabled={!reorderable || position < 0 || position >= total - 1} onSelect={() => void movePlaylistRow(row, 1)}><ArrowDown />{t('library.playlist.moveLater')}</DropdownMenu.Item>
                <DropdownMenu.Separator className="sep" />
              </>}
              <DropdownMenu.Item className="item" onSelect={() => void useLibrary.getState().setPinned([row.id], !row.pinned)}>
                {row.pinned ? <PinOff /> : <Pin />}
                {row.pinned ? t('library.select.unpin') : t('library.select.pinToTop')}
              </DropdownMenu.Item>
              <DropdownMenu.Item className="item" onSelect={() => void useLibrary.getState().setHidden([row.id], !row.hidden)}>
                {row.hidden ? <Undo2 /> : <EyeOff />}
                {row.hidden ? t('library.folder.includeInLibrary') : t('library.folder.excludeFromLibrary')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </DropdownMenu.Root>
      {editing && <RenameDialog key={editing.id} detail={editing} open onOpenChange={(open) => {
        if (!open && useRenameMedia.getState() === rename) useRenameMedia.setState({ row: null })
      }} />}
      {tagging && <TagPicker tags={tags.map((tag) => tag.name)} selected={selectedTags} saveError={tagError} onChange={changeTags} rect={tagging.rect} anchor={tagging.anchor} onClose={() => setTagging(null)} />}
    </>
  )
}

function RenameDialog({ detail, open, onOpenChange }: { detail: MediaRow; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const setTitle = useLibrary((s) => s.setTitle)
  const [title, setValue] = useState(detail.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (open) setValue(detail.title)
  }, [open, detail.title])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(false)
    try {
      if (title.trim() !== detail.title) await setTitle(detail.id, title)
      onOpenChange(false)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('common.rename')} width={420}>
      <form className="prompt" onSubmit={submit}>
        <h2>{t('common.rename')}</h2>
        <Field label={t('library.detail.metadataTitle')} hint={t('library.detail.metadataTitleHint')}>
          <input autoFocus className="input" value={title} disabled={saving} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {error && <p role="alert">{t('settings.section.saveFailed')}</p>}
        <div className="actions">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

import { Lock, Merge, Pencil, Search, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SupporterOffer } from '@/components/account/SupporterOffer'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { Toast } from '@/components/ui/Toast'
import { on } from '@/ipc'
import { cx } from '@/lib/cx'
import { isFree, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useTagManager, type TagResult } from '@/state/tagManager'
import './tagManager.css'

type Sort = 'count' | 'name'
type Ask = { kind: 'delete' | 'merge'; names: string[] }

const tagName = (name: string) => name.trim().toLowerCase()

export function TagManager() {
  const t = useT()
  const free = useAccount(isFree)
  const tags = useTagManager((s) => s.tags)
  const blocked = useTagManager((s) => s.blocked)
  const last = useTagManager((s) => s.history.at(-1)?.label)
  const busy = useTagManager((s) => s.busy)
  const { load, remove, merge, allow, undo } = useTagManager.getState()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('count')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [toast, setToast] = useState<(TagResult & { id: number }) | null>(null)

  useEffect(() => {
    void load()
    return on('library:changed', (change) => {
      if (change.kind !== 'thumbs') void load()
    })
  }, [load])

  const rows = useMemo(() => {
    const q = tagName(query)
    const list = tags.filter((tag) => tag.name.includes(q))
    return sort === 'name' ? list : [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [tags, query, sort])
  const max = useMemo(() => Math.max(1, ...tags.map((tag) => tag.count)), [tags])
  const counts = useMemo(() => new Map(tags.map((tag) => [tag.name, tag.count])), [tags])
  const selected = useMemo(() => [...picked].filter((name) => counts.has(name)), [picked, counts])
  const shownPicked = rows.filter((tag) => picked.has(tag.name)).length

  const show = (result: TagResult | null) => {
    if (!result) return
    setToast({ ...result, id: Date.now() })
    if (result.ok) setPicked(new Set())
  }
  const stepBack = async () => {
    if (!last || busy) return
    setToast(null)
    if (!(await undo())) show({ label: t('library.tag.saveFailed'), ok: false })
  }
  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  const toggleShown = (on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const tag of rows) {
        if (on) next.add(tag.name)
        else next.delete(tag.name)
      }
      return next
    })

  useEffect(() => {
    if (free) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || ask) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void stepBack()
      } else if (e.key === 'Escape') setPicked(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const mergeTarget = ask?.kind === 'merge' ? [...ask.names].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0] : ''

  return (
    <section className="page util-page tm-page">
      <div className="page-hd">
        <h1>
          {t('utilities.tags')}
          {free && <Lock className="tm-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
        <span className="count">{t('utilities.tags.count', { count: tags.length })}</span>
        <span className="spacer" />
        <Button onClick={() => void stepBack()} disabled={free || busy || !last} title={last}>
          <Undo2 />
          {t('common.undo')}
        </Button>
      </div>
      {free && <SupporterOffer />}
      <div className="tm-tool" inert={free}>
        <div className="tm-tools">
          <label className="tm-search">
            <Search />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('library.tag.search')} aria-label={t('library.tag.search')} />
          </label>
          <Segmented
            label={t('tv.grid.sort')}
            value={sort}
            onChange={setSort}
            options={[
              { value: 'count', label: t('utilities.tags.mostUsed') },
              { value: 'name', label: t('library.sort.name') },
            ]}
          />
        </div>
        <div className="tm-head">
          <Checkbox
            checked={rows.length > 0 && shownPicked === rows.length}
            mixed={shownPicked > 0 && shownPicked < rows.length}
            onChange={() => toggleShown(shownPicked < rows.length)}
            disabled={rows.length === 0}
            aria-label={t('library.select.all', { count: rows.length })}
          />
          <span>{t('common.name')}</span>
          <span className="tm-num">{t('downloads.videos')}</span>
        </div>
        <div className="tm-scroll">
          {rows.length === 0 && <p className="faint util-empty">{t('library.tag.noResults')}</p>}
          <ul className="tm-list">
            {rows.map((tag) =>
              renaming === tag.name ? (
                <RenameRow
                  key={tag.name}
                  name={tag.name}
                  count={tag.count}
                  taken={(name) => name !== tag.name && counts.has(name)}
                  onDone={(to) => {
                    setRenaming(null)
                    if (to) void merge([tag.name], to).then(show)
                  }}
                />
              ) : (
                <li key={tag.name}>
                  <label className={cx('tm-row', picked.has(tag.name) && 'on')}>
                    <Checkbox checked={picked.has(tag.name)} onChange={(on) => toggle(tag.name, on)} />
                    <span className="tm-name">{tag.name}</span>
                    <span className="tm-bar" aria-hidden>
                      <i style={{ width: `${(tag.count / max) * 100}%` }} />
                    </span>
                    <span className="tm-num">{tag.count}</span>
                    <span className="tm-acts">
                      <IconButton size="sm" label={t('common.rename')} onClick={() => setRenaming(tag.name)}>
                        <Pencil />
                      </IconButton>
                      <IconButton size="sm" label={t('common.delete')} onClick={() => setAsk({ kind: 'delete', names: [tag.name] })}>
                        <Trash2 />
                      </IconButton>
                    </span>
                  </label>
                </li>
              ),
            )}
          </ul>
          {blocked.length > 0 && (
            <>
              <h3 className="eyebrow tm-blocked-hd">{t('utilities.tags.blocked')}</h3>
              <ul className="tm-list">
                {blocked.map((name) => (
                  <li key={name} className="tm-row tm-blocked">
                    <span className="tm-name">{name}</span>
                    <Button variant="ghost" disabled={busy} onClick={() => void allow(name).then(show)}>
                      {t('utilities.tags.allow')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      {selected.length > 0 && !free && (
        <div className="tm-selbar" role="toolbar" aria-label={t('library.select.toolbar')}>
          <span className="count">{t('library.select.selected', { count: selected.length })}</span>
          {selected.length === 1 ? (
            <Button
              onClick={() => {
                const name = selected[0]!
                if (!rows.some((tag) => tag.name === name)) setQuery('')
                setRenaming(name)
              }}
            >
              <Pencil />
              {t('common.rename')}
            </Button>
          ) : (
            <Button onClick={() => setAsk({ kind: 'merge', names: selected })}>
              <Merge />
              {t('utilities.tags.merge')}
            </Button>
          )}
          <Button className="btn-danger" onClick={() => setAsk({ kind: 'delete', names: selected })}>
            <Trash2 />
            {t('common.delete')}
          </Button>
          <IconButton label={t('common.cancel')} onClick={() => setPicked(new Set())}>
            <X />
          </IconButton>
        </div>
      )}
      {toast && selected.length === 0 && (
        <Toast
          key={toast.id}
          message={toast.label}
          onHide={() => setToast(null)}
          action={
            toast.ok && last ? (
              <Button onClick={() => void stepBack()}>
                <Undo2 />
                {t('common.undo')}
              </Button>
            ) : undefined
          }
        />
      )}
      <DeleteDialog
        names={ask?.kind === 'delete' ? ask.names : null}
        count={ask?.kind === 'delete' && ask.names.length === 1 ? (counts.get(ask.names[0]!) ?? 0) : 0}
        onClose={() => setAsk(null)}
        onConfirm={(names, block) => void remove(names, block).then(show)}
      />
      <Prompt
        open={ask?.kind === 'merge'}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t('utilities.tags.mergeTitle', { count: ask?.names.length ?? 0 })}
        body={ask?.names.join(', ')}
        placeholder={t('library.tag.placeholder')}
        defaultValue={mergeTarget}
        suggestions={tags.map((tag) => tag.name)}
        confirmLabel={t('utilities.tags.merge')}
        onConfirm={(into) => ask && void merge(ask.names, into).then(show)}
      />
    </section>
  )
}

function RenameRow({ name, count, taken, onDone }: { name: string; count: number; taken: (name: string) => boolean; onDone: (to: string | null) => void }) {
  const t = useT()
  const [value, setValue] = useState(name)
  const settled = useRef(false)
  const next = tagName(value)
  const finish = (to: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(to && tagName(to) !== name ? to : null)
  }
  return (
    <li>
      <div className="tm-row editing">
        <span className="tm-check-gap" />
        <input
          className="tm-rename"
          autoFocus
          onFocus={(e) => e.target.select()}
          value={value}
          aria-label={t('library.tag.renameTitle', { name })}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') finish(null)
          }}
        />
        <span className="tm-hint">{taken(next) && t('utilities.tags.mergesWith', { name: next })}</span>
        <span className="tm-num">{count}</span>
        <span />
      </div>
    </li>
  )
}

function DeleteDialog({ names, count, onClose, onConfirm }: { names: string[] | null; count: number; onClose: () => void; onConfirm: (names: string[], block: boolean) => void }) {
  const t = useT()
  const [block, setBlock] = useState(false)
  useEffect(() => {
    if (names) setBlock(false)
  }, [names])
  const one = names?.length === 1 ? names[0]! : null
  const title = one ? t('library.tag.deleteTitle', { name: one }) : t('utilities.tags.deleteTitle', { count: names?.length ?? 0 })
  return (
    <Modal open={names !== null} onOpenChange={(open) => !open && onClose()} title={title} width={360}>
      <form
        className="prompt"
        onSubmit={(e) => {
          e.preventDefault()
          if (names) onConfirm(names, block)
          onClose()
        }}
      >
        <h2>{title}</h2>
        <p>{one ? t('library.tag.deleteBody', { count }) : names?.join(', ')}</p>
        <label className="tm-opt">
          <Checkbox checked={block} onChange={setBlock} />
          {t('utilities.tags.stopAutoTag')}
        </label>
        <div className="actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" className="btn-danger">
            {t('common.delete')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

import { ArrowLeft, FileJson2, FileVideoCamera } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DownloadArchiveEntry } from '@shared/downloads'
import { Button } from '@/components/ui/Button'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { extractionProgress, selectedIds, toggleKind, type ArchiveView } from './archiveView'
import { formatDownloadBytes } from './downloadPresentation'

export function ArchiveControls({ id, view, onBackToTopic, active = true }: { id: string; view: ArchiveView; onBackToTopic?: () => void; active?: boolean }) {
  const t = useT()
  if (view.kind === 'password') return <ArchivePassword key={`${id}:${view.wrong}`} id={id} wrong={view.wrong} active={active} onBackToTopic={onBackToTopic} />
  if (view.kind === 'select') return <ArchiveSelection key={id} id={id} entries={view.entries} />
  if (view.kind === 'published') return <details className="download-archive download-archive-published"><summary>{t('downloads.extractedFiles')} <span>{view.entries.length}</span></summary><EntryList entries={view.entries} published /></details>
  const progress = extractionProgress(view)
  return (
    <div className="download-archive">
      <EntryList entries={view.entries} />
      {view.extracting && <>
        {progress !== null && <div className="download-progress" role="progressbar" aria-label={t('downloads.phase.extracting')} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }} /></div>}
        <div className="download-bytes">{formatDownloadBytes(view.extractedBytes)} / {formatDownloadBytes(view.totalBytes)}</div>
      </>}
    </div>
  )
}

function ArchivePassword({ id, wrong, onBackToTopic, active }: { id: string; wrong: boolean; onBackToTopic?: () => void; active: boolean }) {
  const t = useT()
  const unlock = useDownloads((store) => store.unlock)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const focusOnMount = useRef(active && wrong)
  useEffect(() => { if (focusOnMount.current) input.current?.focus() }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy.current || password.length === 0) return
    busy.current = true
    setPending(true)
    const accepted = await unlock(id, password)
    busy.current = false
    setPending(false)
    if (accepted) setPassword('')
  }
  return (
    <form className="download-archive download-password" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`archive-password-${id}`}>{t('settings.source.password')}</label>
      <div className="download-password-row">
        <input ref={input} id={`archive-password-${id}`} type="password" value={password} maxLength={256} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={wrong || undefined} aria-describedby={wrong ? `archive-password-error-${id}` : undefined} readOnly={pending} onChange={(event) => setPassword(event.target.value)} />
        <Button type="submit" variant="primary" disabled={password.length === 0 || pending}>{t('downloads.unlock')}</Button>
      </div>
      {wrong && <p className="download-password-error" id={`archive-password-error-${id}`} role="alert">{t('settings.source.wrongPassword')}</p>}
      {onBackToTopic && <Button variant="ghost" className="download-password-back" onClick={onBackToTopic}><ArrowLeft />{t('eroscripts.backToTopic')}</Button>}
    </form>
  )
}

function ArchiveSelection({ id, entries }: { id: string; entries: DownloadArchiveEntry[] }) {
  const t = useT()
  const select = useDownloads((store) => store.selectArchive)
  const [selected, setSelected] = useState(() => new Set(entries.filter((entry) => entry.selected).map((entry) => entry.id)))
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const chosen = selectedIds(selected, entries)
  const submit = async () => {
    if (busy.current || chosen.length === 0) return
    busy.current = true
    setPending(true)
    await select(id, chosen)
    busy.current = false
    setPending(false)
  }
  const toggle = (entry: string) => setSelected((current) => {
    const next = new Set(current)
    if (!next.delete(entry)) next.add(entry)
    return next
  })
  return (
    <div className="download-archive">
      {(['video', 'script'] as const).map((kind) => {
        const group = entries.filter((entry) => entry.kind === kind)
        if (!group.length) return null
        const count = group.filter((entry) => selected.has(entry.id)).length
        const label = t(kind === 'video' ? 'downloads.videos' : 'eroscripts.scripts')
        return (
          <fieldset key={kind} className="download-archive-group">
            <legend>{group.length > 1 ? <GroupToggle checked={count === group.length} mixed={count > 0 && count < group.length} disabled={pending} label={label} onChange={(on) => setSelected((current) => toggleKind(current, entries, kind, on))} /> : label}<span>{count}/{group.length}</span></legend>
            <ul className="download-archive-list">
              {group.map((entry) => <li key={entry.id}><label><input type="checkbox" checked={selected.has(entry.id)} disabled={pending} onChange={() => toggle(entry.id)} /><EntryIcon entry={entry} /><span title={entry.name}>{entry.name}</span><small>{formatDownloadBytes(entry.bytes)}</small></label></li>)}
            </ul>
          </fieldset>
        )
      })}
      <Button variant="primary" className="download-archive-submit" disabled={chosen.length === 0 || pending} onClick={() => void submit()}>{t('downloads.importSelected')}</Button>
    </div>
  )
}

function GroupToggle({ checked, mixed, disabled, label, onChange }: { checked: boolean; mixed: boolean; disabled: boolean; label: string; onChange: (on: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (input.current) input.current.indeterminate = mixed }, [mixed])
  return <label><input ref={input} type="checkbox" checked={checked} disabled={disabled} onChange={() => onChange(!checked)} />{label}</label>
}

function EntryList({ entries, published = false }: { entries: DownloadArchiveEntry[]; published?: boolean }) {
  return (
    <ul className="download-archive-list">
      {entries.map((entry) => {
        const name = published ? entry.publishedName ?? entry.name : entry.name
        return <li key={entry.id}><EntryIcon entry={entry} /><span title={name}>{name}</span></li>
      })}
    </ul>
  )
}

function EntryIcon({ entry }: { entry: DownloadArchiveEntry }) {
  return entry.kind === 'video' ? <FileVideoCamera aria-hidden /> : <FileJson2 aria-hidden />
}

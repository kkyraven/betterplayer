import { CircleCheck, FolderOpen, Lock, Pause, Play, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isPlaylist, type MediaRow } from '@shared/library'
import type { MessageKey } from '@shared/i18n'
import type { ProjectionKind } from '@shared/projection'
import { isUrl } from '@shared/remote'
import { SupporterOffer } from '@/components/account/SupporterOffer'
import { resolutionLabel } from '@/components/media/MediaCard'
import { ThumbnailImage } from '@/components/media/ThumbnailImage'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { Prompt } from '@/components/ui/Prompt'
import { Switch } from '@/components/ui/Switch'
import { invoke } from '@/ipc'
import { fmtDuration } from '@/lib/format'
import { electron, REVEAL_LABEL } from '@/node'
import { isFree, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { secondsLeft, useCreator, type Job } from '@/state/passthroughCreator'
import '@/components/ui/Prompt.css'
import './tagManager.css'
import './passthroughCreator.css'

const PROJECTION: Record<ProjectionKind, MessageKey> = { flat: 'projection.flat', equirect180: 'projection.equirect180', equirect360: 'projection.equirect360', fisheye: 'projection.fisheye' }

const fmtSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

const PICK_LIMIT = 200

export function PassthroughCreator() {
  const t = useT()
  const free = useAccount(isFree)
  const jobs = useCreator((s) => s.jobs)
  const beside = useCreator((s) => s.beside)
  const [adding, setAdding] = useState(false)
  const making = jobs.filter((j) => j.state === 'making' || j.state === 'saving')
  const queued = jobs.filter((j) => j.state === 'queued' || j.state === 'error')
  const ready = jobs.filter((j) => j.state === 'ready')

  return (
    <section className="page util-page ptc-page">
      <div className="page-hd">
        <h1>
          {t('utilities.passthrough')}
          {free && <Lock className="tm-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
        {ready.length > 0 && <span className="count">{t('utilities.passthrough.readyCount', { count: ready.length })}</span>}
        <span className="spacer" />
        <Button variant="primary" onClick={() => setAdding(true)} disabled={free}>
          <Plus />
          {t('utilities.passthrough.add')}
        </Button>
      </div>
      {free && <SupporterOffer />}
      <div className="ptc-tool" inert={free}>
        <label className="ptc-strip">
          <Switch checked={beside} onCheckedChange={(on) => useCreator.getState().setBeside(on)} label={t('utilities.passthrough.beside')} />
          <span>
            {t('utilities.passthrough.beside')}
            <small>{t('utilities.passthrough.besideHint')}</small>
          </span>
        </label>
        <div className="ptc-scroll">
          {jobs.length === 0 && <p className="faint util-empty">{t('utilities.passthrough.empty')}</p>}
          <Part title={t('utilities.passthrough.making')} jobs={making} />
          <Part title={t('utilities.passthrough.queued')} jobs={queued} />
          <Part title={t('utilities.passthrough.ready')} jobs={ready} />
        </div>
      </div>
      <Picker open={adding} onClose={() => setAdding(false)} have={new Set(jobs.map((j) => j.path))} />
    </section>
  )
}

function Part({ title, jobs }: { title: string; jobs: Job[] }) {
  if (jobs.length === 0) return null
  return (
    <>
      <h2 className="ptc-sec">
        {title}
        <span>{jobs.length}</span>
      </h2>
      <ul className="ptc-list">
        {jobs.map((j) => (
          <JobRow key={j.path} job={j} />
        ))}
      </ul>
    </>
  )
}

function Thumb({ src, keyed }: { src: string | null; keyed?: boolean }) {
  return <span className="ptc-thumb">{src && <ThumbnailImage src={src} keyed={keyed} alt="" draggable={false} loading="lazy" decoding="async" />}</span>
}

function JobRow({ job }: { job: Job }) {
  const t = useT()
  const { pause, remove, retry } = useCreator.getState()
  const [deleting, setDeleting] = useState(false)
  const meta = [t(PROJECTION[job.projection]), resolutionLabel(job.height) || null, fmtDuration(job.durationMs), job.alpha ? fmtSize(job.alpha.bytes) : null].filter(Boolean).join(' · ')
  const pct = job.total > 0 ? Math.min(100, Math.floor((job.seconds / job.total) * 100)) : 0
  const left = secondsLeft(job)
  const status = job.state === 'saving' ? t('utilities.passthrough.saving') : job.paused ? t('utilities.passthrough.paused') : left === null ? '' : left < 60 ? t('utilities.passthrough.secondsLeft', { count: left }) : t('utilities.passthrough.left', { count: Math.ceil(left / 60) })
  return (
    <li className={job.paused ? 'ptc-row paused' : 'ptc-row'}>
      <Thumb src={job.thumb} keyed={job.keyed} />
      <div className="ptc-name">
        <b>{job.title}</b>
        <span className="faint">{job.state === 'error' ? <span className="ptc-error">{job.error}</span> : meta}</span>
      </div>
      {job.state === 'making' || job.state === 'saving' ? (
        <div className="ptc-prog">
          <div className="ptc-line">
            <span>{pct}%</span>
            <span>{status}</span>
          </div>
          <div className="ptc-bar">
            <i style={{ width: `${job.state === 'saving' ? 100 : pct}%` }} />
          </div>
        </div>
      ) : job.alpha ? (
        <span className="ptc-chip">
          <CircleCheck />
          {t(job.alpha.beside ? 'utilities.passthrough.besideVideo' : 'utilities.passthrough.inApp')}
        </span>
      ) : (
        <span />
      )}
      <div className="ptc-acts">
        {job.state === 'making' && (
          <IconButton size="sm" label={t(job.paused ? 'utilities.passthrough.resume' : 'common.pause')} onClick={() => pause(job.path, !job.paused)}>
            {job.paused ? <Play /> : <Pause />}
          </IconButton>
        )}
        {job.state === 'error' && (
          <IconButton size="sm" label={t('common.retry')} onClick={() => retry(job.path)}>
            <RotateCcw />
          </IconButton>
        )}
        {job.alpha && (
          <IconButton size="sm" label={t(REVEAL_LABEL)} onClick={() => job.alpha && electron.shell.showItemInFolder(job.alpha.path)}>
            <FolderOpen />
          </IconButton>
        )}
        {job.state !== 'saving' && (
          <IconButton size="sm" label={t(job.state === 'ready' ? 'common.delete' : 'common.remove')} onClick={() => (job.state === 'ready' ? setDeleting(true) : remove(job.path))}>
            {job.state === 'ready' ? <Trash2 /> : <X />}
          </IconButton>
        )}
      </div>
      <Prompt open={deleting} onOpenChange={setDeleting} title={t('utilities.passthrough.deleteTitle')} body={job.alpha?.path} confirmLabel={t('common.delete')} danger onConfirm={() => remove(job.path)} />
    </li>
  )
}

function Picker({ open, onClose, have }: { open: boolean; onClose: () => void; have: ReadonlySet<string> }) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<MediaRow[]>([])
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    if (!open) return
    let live = true
    const query = { section: 'all' as const, sort: 'name' as const, desc: false, filters: { type: 'vr' as const }, limit: PICK_LIMIT, offset: 0, ...(search.trim() ? { search: search.trim() } : {}) }
    void invoke('library:query', query).then((page) => live && setRows(page.rows.filter((r): r is MediaRow => !isPlaylist(r))))
    return () => {
      live = false
    }
  }, [open, search])
  useEffect(() => {
    if (!open) {
      setPicked(new Set())
      setSearch('')
    }
  }, [open])
  const shown = rows.filter((r) => !have.has(r.path) && !isUrl(r.path))
  const toggle = (id: number) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])))
  const add = () => {
    void useCreator.getState().add(shown.filter((r) => picked.has(r.id)))
    onClose()
  }
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t('utilities.passthrough.add')} width={460}>
      <div className="prompt ptc-picker">
        <h2>{t('utilities.passthrough.add')}</h2>
        <label className="tm-search">
          <Search />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('utilities.passthrough.search')} aria-label={t('utilities.passthrough.search')} autoFocus />
        </label>
        <ul className="ptc-picks">
          {shown.length === 0 && <li className="faint util-empty">{t('utilities.passthrough.noVideos')}</li>}
          {shown.map((r) => (
            <li key={r.id}>
              <label className="ptc-pick">
                <Checkbox checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                <Thumb src={r.thumb} keyed={r.keyed} />
                <span className="ptc-name">
                  <b>{r.title}</b>
                  <span className="faint">{[t(PROJECTION[r.projection]), fmtDuration(r.durationMs)].join(' · ')}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={add} disabled={picked.size === 0}>
            {picked.size > 0 ? t('utilities.passthrough.addCount', { count: picked.size }) : t('common.add')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

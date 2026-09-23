import { Bookmark, Clock3, Play, Star, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { Prompt } from '@/components/ui/Prompt'
import { Switch } from '@/components/ui/Switch'
import { PacingCurve } from '@/components/session/PacingCurve'
import { buildPhases, PACING_LABEL_KEY } from '@/session/pacing'
import { useT } from '@/state/i18n'
import { useSession } from '@/state/session'
import { timeText } from './SessionTimeline'

export function SaveSession({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT()
  const currentName = useSession((s) => s.name),
    save = useSession((s) => s.save),
    busy = useSession((s) => s.busy),
    error = useSession((s) => s.error)
  const [name, setName] = useState(currentName === t('session.defaultName') ? '' : currentName),
    [favourite, setFavourite] = useState(false)
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('session.save.title')} width={440}>
      <form
        className="save-session"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await save(name, favourite)) onOpenChange(false)
        }}
      >
        <header>
          <h2>{t('session.save.title')}</h2>
          <IconButton label={t('session.save.close')} onClick={() => onOpenChange(false)}>
            <X />
          </IconButton>
        </header>
        <label className="session-field">
          {t('session.save.name')}
          <input autoFocus value={name} maxLength={120} placeholder={t('session.save.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="opt">
          <span>{t('session.save.favourite')}</span>
          <Switch label={t('session.save.favouriteSession')} checked={favourite} onCheckedChange={setFavourite} />
        </label>
        <p className="session-hint">{t('session.save.hint')}</p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? t('session.save.saving') : t('session.save.title')}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}

export function SessionLibrary({ tab, onLoaded }: { tab: 'saved' | 'history'; onLoaded: () => void }) {
  const t = useT()
  const saved = useSession((s) => s.saved),
    history = useSession((s) => s.history),
    busy = useSession((s) => s.busy),
    stage = useSession((s) => s.stage)
  const load = useSession((s) => s.load),
    replay = useSession((s) => s.replay),
    favourite = useSession((s) => s.favourite),
    deleteSaved = useSession((s) => s.deleteSaved)
  const [query, setQuery] = useState(''),
    [onlyFavourites, setOnlyFavourites] = useState(false),
    [deleting, setDeleting] = useState<number | null>(null)
  const items = (tab === 'saved' ? saved : history).filter((s) => (!onlyFavourites || s.favourite) && s.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <section className="session-library">
      <div className="session-library-tools">
        <input aria-label={t('session.library.find')} placeholder={t('session.library.findPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button variant={onlyFavourites ? 'primary' : 'ghost'} aria-pressed={onlyFavourites} onClick={() => setOnlyFavourites(!onlyFavourites)}>
          <Star />
          {t('session.library.favourites')}
        </Button>
      </div>
      <div className={tab === 'saved' ? 'saved-session-grid' : 'session-history'}>
        {items.map((item) => {
          const setup = 'setup' in item ? item.setup : item.run?.setup
          const totalMs = 'totalMs' in item ? item.totalMs : item.setup.totalMin * 60000
          const phases = 'run' in item ? (item.run?.phases ?? []) : buildPhases(item.setup.pacing, totalMs, () => 0.5)
          return (
            <article className="saved-session" key={item.id}>
              <header>
                <h3 title={item.name}>{item.name}</h3>
                <IconButton
                  label={item.favourite ? t('session.library.unfavourite', { name: item.name }) : t('session.library.favourite', { name: item.name })}
                  aria-pressed={item.favourite}
                  onClick={() => void favourite(tab, item.id, !item.favourite)}
                >
                  <Star className={item.favourite ? 'favourited' : ''} />
                </IconButton>
              </header>
              <PacingCurve phases={phases} totalMs={totalMs} height={48} />
              <div className="session-record-meta">
                <span>{'setup' in item && item.setup.totalMin !== item.setup.totalMax ? t('session.library.lengthRange', { min: item.setup.totalMin, max: item.setup.totalMax }) : timeText(totalMs)}</span>
                <span>{setup ? t(PACING_LABEL_KEY[setup.pacing.kind]) : t('session.library.previousSession')}</span>
                {'startedAt' in item && <span>{new Date(item.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>}
              </div>
              {'status' in item && (
                <p className="session-hint">
                  {t('session.library.status', {
                    clips: t('session.count.clips', { count: item.clipCount }),
                    status:
                      item.status === 'completed'
                        ? t('session.library.completed')
                        : item.status === 'running'
                          ? t('session.library.running')
                          : item.status === 'legacy'
                            ? t('session.library.legacy')
                            : t('session.library.endedEarly'),
                  })}
                </p>
              )}
              <footer>
                {'setup' in item ? (
                  <>
                    <Button
                      onClick={() => {
                        void load('saved', item.id).then((ok) => {
                          if (ok) onLoaded()
                        })
                      }}
                      disabled={busy || stage === 'running'}
                    >
                      <Bookmark />
                      {t('session.library.load')}
                    </Button>
                    <IconButton label={t('session.library.delete', { name: item.name })} onClick={() => setDeleting(item.id)}>
                      <Trash2 />
                    </IconButton>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => void replay(item.id)}
                      disabled={!item.run || busy || stage === 'running'}
                    >
                      <Play />
                      {t('session.result.playAgain')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void load('history', item.id).then((ok) => {
                          if (ok) onLoaded()
                        })
                      }}
                      disabled={!item.run || busy || stage === 'running'}
                    >
                      {t('session.library.loadSetup')}
                    </Button>
                  </>
                )}
              </footer>
            </article>
          )
        })}
      </div>
      {!items.length && (
        <div className="session-library-empty">
          {tab === 'saved' ? <Bookmark /> : <Clock3 />}
          <h2>{query || onlyFavourites ? t('session.library.noMatching') : tab === 'saved' ? t('session.library.noSaved') : t('session.library.noHistory')}</h2>
          <p>{tab === 'saved' ? t('session.library.savedHint') : t('session.library.historyHint')}</p>
        </div>
      )}
      <Prompt
        open={deleting !== null}
        onOpenChange={(on) => {
          if (!on) setDeleting(null)
        }}
        title={t('session.library.deleteTitle')}
        body={t('session.library.deleteBody')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (deleting !== null) void deleteSaved(deleting)
          setDeleting(null)
        }}
      />
    </section>
  )
}

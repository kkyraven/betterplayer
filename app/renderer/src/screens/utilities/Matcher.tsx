import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRight, ChevronRight, Ellipsis, FolderOpen, Link, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LIKELY, REASON_LABEL, renamedScript, type MatchCandidate, type OrphanSet } from '@shared/matcher'
import { AxisChips } from '@/components/media/AxisChips'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Prompt } from '@/components/ui/Prompt'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'

const nodePath = window.require('node:path') as typeof import('node:path')
import { electron, REVEAL_LABEL } from '@/node'
import { useLibrary } from '@/state/library'
import { likelySets, useMatcher } from '@/state/matcher'
import { usePlayer } from '@/state/player'
import './matcher.css'

const band = (confidence: number) => (confidence >= LIKELY ? 'likely' : confidence >= 0.5 ? 'maybe' : 'weak')
const pct = (confidence: number) => `${Math.round(confidence * 100)}%`

export function Matcher() {
  const t = useT()
  const report = useMatcher((s) => s.report)
  const scanning = useMatcher((s) => s.scanning)
  const scan = useMatcher((s) => s.scan)
  const resolveLikely = useMatcher((s) => s.resolveLikely)
  const roots = useLibrary((s) => s.roots)
  const [askAll, setAskAll] = useState(false)
  useEffect(() => {
    if (!useMatcher.getState().report) void scan()
  }, [scan])
  const likely = likelySets(report)
  const sets = report?.sets ?? []

  return (
    <section className="page util-page">
      <div className="page-hd">
        <h1>{t('utilities.matcher')}</h1>
        {report && <span className="count">{sets.length === 0 ? t('matcher.allMatched') : t('matcher.unmatched', { count: sets.length })}</span>}
        <span className="spacer" />
        <Button onClick={() => void scan()} disabled={scanning}>
          <RefreshCw />
          {scanning ? t('matcher.scanning') : t('matcher.rescan')}
        </Button>
        {likely.length > 0 && (
          <Button variant="primary" onClick={() => setAskAll(true)}>
            <Link />
            {t('matcher.renameLikely', { count: likely.length })}
          </Button>
        )}
      </div>
      {!report ? (
        <p className="faint util-empty">{t('matcher.scanning')}</p>
      ) : sets.length === 0 ? (
        <p className="faint util-empty">{roots.length === 0 ? t('matcher.addFolder') : t('matcher.everyMatched')}</p>
      ) : (
        <div className="mt-list">
          {sets.map((set) => (
            <MatchRow key={set.id} set={set} />
          ))}
        </div>
      )}
      <Prompt
        open={askAll}
        onOpenChange={setAskAll}
        title={t('matcher.renameAllTitle', { count: likely.length })}
        body={t('matcher.renameAllBody')}
        confirmLabel={t('common.rename')}
        onConfirm={() => void resolveLikely()}
      />
    </section>
  )
}

function MatchRow({ set }: { set: OrphanSet }) {
  const t = useT()
  const busy = useMatcher((s) => s.busy.has(set.id))
  const error = useMatcher((s) => s.errors[set.id])
  const resolve = useMatcher((s) => s.resolve)
  const best = set.candidates[0]
  const reveal = () => electron.shell.showItemInFolder(nodePath.join(set.dir, set.files[0]?.name ?? ''))

  return (
    <div className={cx('mt-row', best && band(best.confidence), busy && 'busy')}>
      <div className="mt-scripts">
        <div className="mt-name">
          <span className="t" title={set.files.map((f) => f.name).join('\n')}>
            {set.stem}
          </span>
          <AxisChips axes={set.files.map((f) => f.axis)} />
        </div>
        <div className="mt-sub">
          <span className="p" title={set.dir}>
            {set.folder || '/'}
          </span>
          {set.durationMs > 0 && <span className="mono">{fmtDuration(set.durationMs)}</span>}
        </div>
      </div>
      <ArrowRight className="mt-arrow" />
      {best ? (
        <Candidate c={best} set={set} />
      ) : (
        <div className="mt-video none">
          <span className="t faint">{t('matcher.noMatch')}</span>
        </div>
      )}
      <div className="mt-acts">
        {best && (
          <Button variant={best.confidence >= LIKELY ? 'primary' : 'default'} disabled={busy} title={renameTitle(set, best)} onClick={() => void resolve(set.id, best.mediaId)}>
            {t('common.rename')}
          </Button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label={t('matcher.options', { name: set.stem })} size="sm" className="mt-more">
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              {set.candidates.length > 1 && (
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="item">
                    <Link />
                    {t('matcher.renameTo')}
                    <ChevronRight className="right" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent className="menu mt-menu" sideOffset={6}>
                      {set.candidates.map((c) => (
                        <DropdownMenu.Item key={c.mediaId} className="item" title={renameTitle(set, c)} onSelect={() => void resolve(set.id, c.mediaId)}>
                          <span className={`mt-pct ${band(c.confidence)}`}>{pct(c.confidence)}</span>
                          <span className="mt-menu-t">{c.title}</span>
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              )}
              <DropdownMenu.Item className="item" onSelect={reveal}>
                <FolderOpen />
                {t(REVEAL_LABEL)}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {error && <div className="mt-error">{error}</div>}
    </div>
  )
}

function Candidate({ c, set }: { c: MatchCandidate; set: OrphanSet }) {
  const t = useT()
  const open = usePlayer((s) => s.open)
  const fail = useMatcher((s) => s.fail)
  const play = async () => {
    const media = await invoke('library:media', c.mediaId)
    if (media) await open(media.path)
    else fail(set.id, t('matcher.gone', { title: c.title }))
  }
  return (
    <div className="mt-video">
      <div className="mt-name">
        <span className={`mt-pct ${band(c.confidence)}`}>{pct(c.confidence)}</span>
        <button type="button" className="t mt-play" title={t('matcher.play', { title: c.title })} onClick={() => void play()}>
          {c.title}
        </button>
      </div>
      <div className="mt-sub">
        <span className="p">{c.folder || '/'}</span>
        {c.durationMs > 0 && <span className="mono">{fmtDuration(c.durationMs)}</span>}
        <span className="why">{c.reasons.map((r) => t(REASON_LABEL[r])).join(', ')}</span>
        {(set.rootId !== c.rootId || set.folder !== c.folder) && <span className="why">{t('matcher.movesFolder')}</span>}
      </div>
    </div>
  )
}

function renameTitle(set: OrphanSet, c: MatchCandidate): string {
  return set.files.map((f) => renamedScript(c.stem, f)).join('\n')
}

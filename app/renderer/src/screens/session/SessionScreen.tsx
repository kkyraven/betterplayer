import { Bookmark, ChevronRight, Eye, EyeOff, Play, Plus, RefreshCw, RotateCcw, Settings2, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { TCODE_AXES, type AxisId } from '@shared/axes'
import { CLIP_MAX_S, CLIP_MIN_S, PACING_KINDS, SESSION_TOTALS, TOTAL_MAX_MINUTES, TOTAL_MIN_MINUTES, type PacingSettings } from '@shared/session'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { PACING_LABEL_KEY } from '@/session/pacing'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSession } from '@/state/session'
import { useUi } from '@/state/ui'
import { AxisToggles } from '@/components/media/AxisToggles'
import { ClipRow, PacingParams, Sources } from './SessionControls'
import { PeriodEditor, SessionTimeline, timeText } from './SessionTimeline'
import { SessionToys } from './SessionToys'
import { SaveSession, SessionLibrary } from './SessionLibrary'
import './session.css'
import './timeline.css'

const TOTAL_OPTIONS = SESSION_TOTALS.map((t) => ({ value: String(t), label: `${t}` }))
const RULE_AXES: AxisId[] = [...TCODE_AXES.map((a) => a.id), 'EA', 'EB', 'EV']

export function SessionScreen() {
  const t = useT()
  const stage = useSession((s) => s.stage),
    error = useSession((s) => s.error),
    revealed = useSession((s) => s.revealed)
  const mount = useLibrary((s) => s.mount),
    refresh = useSession((s) => s.refresh),
    refreshSaved = useSession((s) => s.refreshSaved)
  const [tab, setTab] = useState<'create' | 'saved' | 'history'>('create'),
    [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false),
    [toys, setToys] = useState(false)
  useEffect(() => mount('session'), [mount])
  useEffect(() => {
    void refresh()
    void refreshSaved()
  }, [refresh, refreshSaved])
  const save = () => setSaving(true)
  return (
    <div className="session timeline-session">
      <header className="sessions-header">
        <h1>{t('session.screen.title')}</h1>
        <nav aria-label={t('session.screen.title')}>
          {(['create', 'saved', 'history'] as const).map((id) => (
            <button
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              className={tab === id ? 'active' : ''}
              onClick={() => {
                setTab(id)
                if (id !== 'create') void refreshSaved()
              }}
            >
              {t(`session.screen.tab.${id}`)}
            </button>
          ))}
        </nav>
        <Button onClick={save}>
          <Bookmark />
          {t('session.screen.save')}
        </Button>
      </header>
      {error && (
        <div className="session-error session-banner" role="alert">
          {error}
          <Button variant="ghost" onClick={() => useSession.setState({ error: null })}>
            {t('session.screen.dismiss')}
          </Button>
        </div>
      )}
      {tab === 'create' ? (
        stage === 'setup' ? (
          <>
            <div className="timeline-workspace">
              <Sources />
              <main className="timeline-main">
                <SessionSettings />
                <SessionTimeline selected={selected} onSelect={setSelected} />
                <AdvancedOptions onToys={() => setToys(true)} />
                {revealed && <RevealedPlan />}
              </main>
              <PeriodEditor selected={selected} onSelect={setSelected} />
            </div>
            <SessionFooter onSelect={setSelected} />
          </>
        ) : (
          <SessionResult onSave={save} />
        )
      ) : (
        <SessionLibrary
          tab={tab}
          onLoaded={() => {
            setSelected(null)
            setTab('create')
          }}
        />
      )}
      {saving && <SaveSession open={saving} onOpenChange={setSaving} />}
      <SessionToys open={toys} onOpenChange={setToys} />
    </div>
  )
}

function SessionSettings() {
  const t = useT()
  const setup = useSession((s) => s.setup),
    setSetup = useSession((s) => s.setSetup)
  const preset = setup.totalMin === setup.totalMax ? String(setup.totalMin) : ''
  const setPacing = (patch: Partial<PacingSettings>) => setSetup({ pacing: { ...setup.pacing, ...patch } })
  const pacingOptions = PACING_KINDS.map((value) => ({ value, label: t(PACING_LABEL_KEY[value]) }))
  return (
    <section className="session-settings">
      <div className="session-setting">
        <span>{t('session.settings.length')}</span>
        <div>
          <Segmented options={TOTAL_OPTIONS} value={preset} onChange={(v) => setSetup({ totalMin: Number(v), totalMax: Number(v) })} label={t('session.settings.sessionLength')} />
          <NumberInput
            value={setup.totalMin}
            min={TOTAL_MIN_MINUTES}
            max={TOTAL_MAX_MINUTES}
            unit={t('session.unit.min')}
            label={t('session.settings.lengthMinimum')}
            onChange={(totalMin) => setSetup({ totalMin, totalMax: Math.max(totalMin, setup.totalMax) })}
          />
          <span className="faint">{t('session.entry.to')}</span>
          <NumberInput value={setup.totalMax} min={setup.totalMin} max={TOTAL_MAX_MINUTES} unit={t('session.unit.min')} label={t('session.settings.lengthMaximum')} onChange={(totalMax) => setSetup({ totalMax })} />
        </div>
      </div>
      <div className="session-setting">
        <span>{t('session.entry.clipLength')}</span>
        <div>
          <NumberInput
            value={setup.clipMinS}
            min={CLIP_MIN_S}
            max={CLIP_MAX_S}
            unit="s"
            label={t('session.entry.clipMinimum')}
            onChange={(clipMinS) => setSetup({ clipMinS, clipMaxS: Math.max(clipMinS, setup.clipMaxS) })}
          />
          <span className="faint">{t('session.entry.to')}</span>
          <NumberInput value={setup.clipMaxS} min={setup.clipMinS} max={CLIP_MAX_S} unit="s" label={t('session.entry.clipMaximum')} onChange={(clipMaxS) => setSetup({ clipMaxS })} />
        </div>
      </div>
      <div className="session-setting">
        <span>{t('session.settings.pacing')}</span>
        <div>
          <Segmented options={pacingOptions} value={setup.pacing.kind} onChange={(kind) => setPacing({ kind })} label={t('session.settings.pacing')} />
          <Sheet
            title={t('session.settings.pacingIntensity')}
            width={530}
            trigger={
              <Button variant="ghost">
                <SlidersHorizontal />
                {t('session.settings.adjust')}
              </Button>
            }
          >
            <PacingParams pacing={setup.pacing} onChange={setPacing} />
          </Sheet>
        </div>
      </div>
      <label className="match-intensity" title={t('session.settings.matchIntensityTitle')}>
        <Switch checked={setup.matchVideos} label={t('session.settings.matchIntensity')} onCheckedChange={(matchVideos) => setSetup({ matchVideos })} />
        <span>{t('session.settings.matchIntensity')}</span>
        <small>{t('session.settings.matchIntensitySub')}</small>
      </label>
    </section>
  )
}

function AdvancedOptions({ onToys }: { onToys: () => void }) {
  const t = useT()
  const setup = useSession((s) => s.setup),
    setSetup = useSession((s) => s.setSetup)
  return (
    <details className="session-advanced">
      <summary>
        <Settings2 size={15} />
        {t('session.advanced.title')}
        <ChevronRight size={14} />
      </summary>
      <div className="opts">
        <label className="opt">
          <span>{t('session.advanced.trackMotion')}</span>
          <Switch checked={setup.tracking} label={t('session.advanced.trackMotion')} onCheckedChange={(tracking) => setSetup({ tracking })} />
        </label>
        <label className="opt">
          <span>{t('session.advanced.scriptedOnly')}</span>
          <Switch checked={setup.scriptedOnly} label={t('session.advanced.scriptedOnly')} onCheckedChange={(scriptedOnly) => setSetup({ scriptedOnly })} />
        </label>
        <label className="opt">
          <span>{t('session.advanced.showTimes')}</span>
          <Switch checked={setup.showTimes} label={t('session.advanced.showTimes')} onCheckedChange={(showTimes) => setSetup({ showTimes })} />
        </label>
        <label className="opt">
          <span>{t('session.advanced.skipLast')}</span>
          <NumberInput
            value={setup.skipLastSessions}
            min={0}
            max={50}
            unit={t('session.unit.sessions')}
            label={t('session.advanced.skipLastSessions')}
            onChange={(skipLastSessions) => setSetup({ skipLastSessions })}
          />
        </label>
        <label className="opt">
          <span>{t('session.advanced.skipRecentlyWatched')}</span>
          <NumberInput value={setup.skipLastWatched} min={0} max={500} unit={t('session.unit.videos')} label={t('session.advanced.skipRecentlyWatched')} onChange={(skipLastWatched) => setSetup({ skipLastWatched })} />
        </label>
        <div className="opt wide">
          <span>{t('session.advanced.needsAxes')}</span>
          <AxisToggles axes={RULE_AXES} on={setup.requireAxes} variant="on" onChange={(requireAxes) => setSetup({ requireAxes })} />
        </div>
        <Button className="toy-open" onClick={onToys}>
          <SlidersHorizontal />
          {t('session.advanced.toyOutput')}<span>{setup.toys.enabled ? t('session.count.rules', { count: setup.toys.rules.length + setup.toys.periods.length }) : t('common.default')}</span>
          <ChevronRight />
        </Button>
      </div>
    </details>
  )
}

function SessionFooter({ onSelect }: { onSelect: (id: string) => void }) {
  const t = useT()
  const plan = useSession((s) => s.plan),
    totalMs = useSession((s) => s.totalMs),
    pool = useSession((s) => s.pool),
    issues = useSession((s) => s.issues)
  const loading = useSession((s) => s.loading),
    busy = useSession((s) => s.busy),
    revealed = useSession((s) => s.revealed),
    showTimes = useSession((s) => s.setup.showTimes)
  const reveal = useSession((s) => s.reveal),
    regenerate = useSession((s) => s.regenerate),
    start = useSession((s) => s.start)
  const issue = issues[0]
  const message =
    issue?.kind === 'empty'
      ? t('session.footer.noVideos')
      : issue?.kind === 'required'
        ? t('session.footer.noMatches', { from: timeText(issue.from * totalMs), to: timeText(issue.to * totalMs) })
        : issue?.kind === 'toy-overlap'
          ? t('session.footer.toyOverlap')
          : issue?.kind === 'length'
            ? t('session.footer.tooManyClips')
            : null
  return (
    <footer className="session-footer">
      <div className={cx('session-ready', issue && 'session-error')} aria-live="polite">
        {loading ? (
          t('session.footer.loading')
        ) : message ? (
          <>
            <span>{message}</span>
            {issue?.ruleId && (
              <Button variant="ghost" onClick={() => onSelect(issue.ruleId!)}>
                {t('session.footer.editPeriod')}
              </Button>
            )}
          </>
        ) : (
          <>
            <b>{plan.length ? t('session.footer.ready') : t('session.footer.chooseSources')}</b>
            <span>
              {showTimes && plan.length > 0
                ? t('session.footer.timedSummary', { time: timeText(totalMs), clips: t('session.count.clips', { count: plan.length }), videos: t('session.count.videos', { count: pool.length }) })
                : t('session.count.videos', { count: pool.length })}
            </span>
          </>
        )}
      </div>
      <Button variant="ghost" disabled={!plan.length || loading} onClick={revealed ? () => useSession.setState({ revealed: false }) : reveal}>
        {revealed ? <EyeOff /> : <Eye />}
        {revealed ? t('session.footer.hide') : t('session.footer.reveal')}
      </Button>
      <Button variant="ghost" disabled={!pool.length || loading || busy} onClick={regenerate}>
        <RefreshCw />
        {t('session.footer.regenerate')}
      </Button>
      <Button variant="primary" className="big-start" onClick={() => void start()} disabled={!plan.length || loading || busy || !!issue}>
        <Play />
        {busy ? t('session.footer.starting') : t('session.footer.start')}
      </Button>
    </footer>
  )
}
function RevealedPlan() {
  const plan = useSession((s) => s.plan)
  return (
    <div className="plist timeline-clip-list">
      {plan.map((clip, i) => (
        <ClipRow key={i} clip={clip} n={i + 1} />
      ))}
    </div>
  )
}
function SessionResult({ onSave }: { onSave: () => void }) {
  const t = useT()
  const stage = useSession((s) => s.stage),
    played = useSession((s) => s.played),
    lastId = useSession((s) => s.lastSessionId),
    busy = useSession((s) => s.busy)
  const end = useSession((s) => s.end),
    replay = useSession((s) => s.replay)
  return (
    <main className="session-result">
      <div className="timeline-heading">
        <h2>{stage === 'running' ? t('session.result.inProgress') : t('session.result.finished')}</h2>
        <div className="session-result-actions">
          {stage === 'running' ? (
            <>
              <Button onClick={() => useUi.getState().setScreen('player')}>
                <Play />
                {t('session.result.returnToPlayer')}
              </Button>
              <Button onClick={() => end()}>{t('session.result.end')}</Button>
            </>
          ) : (
            <>
              <Button onClick={() => end()}>
                <Plus />
                {t('session.result.new')}
              </Button>
              <Button onClick={onSave}>
                <Bookmark />
                {t('session.result.saveSetup')}
              </Button>
              <Button
                variant="primary"
                disabled={lastId === null || busy}
                onClick={() => {
                  if (lastId !== null) void replay(lastId)
                }}
              >
                <RotateCcw />
                {t('session.result.playAgain')}
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="plist">
        {played.map((clip, i) => (
          <ClipRow key={i} clip={clip} n={i + 1} />
        ))}
      </div>
    </main>
  )
}

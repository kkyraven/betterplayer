import { AXIS_NAME } from '@shared/axes'
import { TRACK_AXES, TRACK_SOURCE_LABEL } from '@shared/tracking'
import { ExportSupport } from '@/components/scripts/ExportSupport'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { fmtDuration } from '@/lib/format'
import { t, useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'
import { useGenerate } from '@/state/generate'
import './GenerateDialog.css'

function timeLeft(timeMs: number, durationMs: number, startedAt: number): string | null {
  const elapsed = performance.now() - startedAt
  if (elapsed < 2000 || timeMs <= 0 || durationMs <= 0) return null
  const rate = timeMs / elapsed
  return t('tracking.generate.timeLeft', { time: fmtDuration(Math.max(0, durationMs - timeMs) / rate) })
}

export function GenerateDialog() {
  const t = useT()
  const target = useGenerate((s) => s.target)
  const currentAxes = useTracking((s) => s.axes)
  const axes = target?.tracking.axes ?? currentAxes
  const heroZone = target?.tracking.heroZone
  const title = target?.title
  const music = useTracking((s) => s.beat?.model)
  const scripts = useGenerate((s) => s.scripts)
  const open = useGenerate((s) => s.open)
  const phase = useGenerate((s) => s.phase)
  const steps = useGenerate((s) => s.steps)
  const progress = useGenerate((s) => s.progress)
  const startedAt = useGenerate((s) => s.startedAt)
  const saved = useGenerate((s) => s.saved)
  const error = useGenerate((s) => s.error)
  const start = useGenerate((s) => s.start)
  const save = useGenerate((s) => s.save)
  const openInEditor = useGenerate((s) => s.openInEditor)
  const cancel = useGenerate((s) => s.cancel)
  const close = useGenerate((s) => s.close)
  const enabled = TRACK_AXES.filter((a) => axes[a.id].source !== 'off' && axes[a.id].source !== 'faptap')
  const saving = steps.some((s) => s.id === 'save' && s.status === 'running')
  const audio = steps.some((s) => s.id === 'audio' && s.status === 'running')
  const running = progress?.status === 'running' && phase === 'running' && !saving
  const left = running ? timeLeft(progress.timeMs, progress.durationMs, startedAt) : null
  const watching = phase === 'running' && !saving && progress?.status === 'music' && music?.status === 'watching'
  const fraction = running && progress.durationMs > 0 ? progress.timeMs / progress.durationMs : watching ? music.percent / 100 : null
  const percent = fraction === null ? null : Math.max(0, Math.min(100, fraction * 100))
  const sources = [...new Set(enabled.map((a) => axes[a.id].source))]
  const videoSources = [...new Set(sources
    .filter((s) => s === 'video' || s === 'ai-motion' || (s === 'hero' && heroZone !== null))
    .map((s) => s === 'ai-motion' && !steps.some((step) => step.id === 'motion') ? 'video' : s))]
  const stage = saving ? t('tracking.generate.chooseSave') : audio ? t('tracking.generate.analyseAudio') : progress?.status === 'music' ? t(TRACK_SOURCE_LABEL['ai-music']) : running ? videoSources.map((s) => t(TRACK_SOURCE_LABEL[s])).join(' · ') || t('tracking.generate.preparing') : t('tracking.generate.preparing')
  const heading = phase === 'done' ? (saved ? t('tracking.generate.saved') : t('tracking.generate.notSaved')) : phase === 'error' ? t('tracking.generate.failed') : phase === 'running' ? t('tracking.generate.exporting') : t('tracking.generate.title')
  const failures = steps.filter((s) => s.status === 'failed')
  const count = saved?.length ?? scripts?.length ?? 0
  return (
    <Modal open={open} onOpenChange={(o) => !o && cancel()} title={heading} width={460}>
      <div className="gen">
        <div className="gen-heading">
          <h3>{heading}</h3>
        </div>
        {phase === 'plan' && (
          <>
            <p>{t('tracking.generate.currentSetup')}</p>
            <div className="gen-file">{title}</div>
            <table className="gen-axes" aria-label={t('tracking.generate.exportAxes')}>
              <tbody>
                {enabled.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{t(AXIS_NAME[a.id])}</th>
                    <td>{t(TRACK_SOURCE_LABEL[axes[a.id].source])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sources.includes('hero') && !heroZone && <p className="err">{t('tracking.generate.noHeroZone')}</p>}
            <ExportSupport />
          </>
        )}
        {phase === 'running' && (
          <div className="gen-progress">
            <p role="status">{stage}</p>
            {percent !== null && (
              <>
                <div className="bar" role="progressbar" aria-label={stage} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
                  <i style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
                <div className="gen-progress-detail">
                  <span>{running ? t('tracking.generate.progress', { time: fmtDuration(progress.timeMs), total: fmtDuration(progress.durationMs) }) : `${Math.round(percent)}%`}</span>
                  {left && <span>{left}</span>}
                </div>
              </>
            )}
          </div>
        )}
        {phase === 'done' && (
          <>
            <p>{t('tracking.generate.funscripts', { count })}</p>
            <div className="gen-file">{title}</div>
          </>
        )}
        {failures.map((s) => <p className="err" key={s.id}>{s.label}: {s.detail}</p>)}
        {phase === 'error' && <p className="err" role="alert">{error}</p>}
        <div className="acts">
          {phase === 'plan' && (
            <>
              <Button variant="ghost" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" disabled={enabled.length === 0} onClick={() => void start()}>
                {t('common.export')}
              </Button>
            </>
          )}
          {phase === 'running' && (
            <Button variant="ghost" onClick={cancel}>
              {t('common.cancel')}
            </Button>
          )}
          {phase === 'done' && (
            <Button onClick={() => void openInEditor()}>{t('tracking.generate.openInEditor')}</Button>
          )}
          {phase === 'done' && !saved && (
            <Button onClick={() => void save()}>{t('common.save')}</Button>
          )}
          {(phase === 'done' || phase === 'error') && (
            <Button variant={saved ? 'primary' : 'ghost'} onClick={close}>
              {t('common.close')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

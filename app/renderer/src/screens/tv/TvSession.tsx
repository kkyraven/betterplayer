import { Play, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { refName } from '@shared/session'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import { useSession } from '@/state/session'
import { useUi } from '@/state/ui'

export function TvSession() {
  const t = useT()
  const setup = useSession((s) => s.setup)
  const plan = useSession((s) => s.plan)
  const candidates = useSession((s) => s.pool)
  const loading = useSession((s) => s.loading || s.busy)
  const error = useSession((s) => s.error)
  const refresh = useSession((s) => s.refresh)
  const regenerate = useSession((s) => s.regenerate)
  const start = useSession((s) => s.start)
  const stage = useSession((s) => s.stage)
  const end = useSession((s) => s.end)
  const setTvTab = useUi((s) => s.setTvTab)
  useEffect(() => void refresh(), [refresh])
  const totalMs = plan.reduce((a, c) => a + c.endMs - c.startMs, 0)
  const length = setup.totalMin === setup.totalMax ? t('tv.session.minutes', { count: setup.totalMin }) : t('tv.session.minutesRange', { from: setup.totalMin, to: setup.totalMax })
  const sources = setup.entries
    .filter((e) => e.role === 'include')
    .map((e) => refName(e.ref, t))
    .join(', ')
  return (
    <div className="tv-session">
      <h1>{t('screen.session')}</h1>
      {stage === 'running' ? (
        <>
          <p>{t('tv.session.running')}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <Button className="big" variant="primary" onClick={() => setTvTab('nowplaying')}>
              <Play />
              {t('tv.session.backToIt')}
            </Button>
            <Button className="big" onClick={() => end()}>
              {t('tv.session.end')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            {setup.showTimes ? `${t('tv.session.clips', { count: plan.length })} · ${fmtDuration(totalMs)} · ` : ''}{t('tv.session.fromVideos', { count: candidates.length })}
            {sources ? ` · ${sources}` : ''}
          </p>
          {plan.length === 0 && <p>{t('tv.session.adjust')}</p>}
          {error && <p role="alert">{error}</p>}
          <div style={{ display: 'flex', gap: 12 }}>
            <Button
              className="big"
              variant="primary"
              disabled={plan.length === 0 || loading}
              onClick={() => {
                void start()
              }}
            >
              <Play />
              {t('tv.session.start', { length })}
            </Button>
            <Button className="big" onClick={regenerate} disabled={plan.length === 0 || loading}>
              <RefreshCw />
              {t('tv.session.regenerate')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

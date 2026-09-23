import { Shuffle } from 'lucide-react'
import { useState } from 'react'
import { PhaseStrip, phaseTone } from '@/components/session/PhaseStrip'
import { Button } from '@/components/ui/Button'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { intensityAt, phaseAt } from '@/session/pacing'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { sessionElapsedMs, sessionRemainingMs, useSession } from '@/state/session'

export function SessionStrip() {
  const t = useT()
  const phases = useSession((s) => s.phases)
  const totalMs = useSession((s) => s.totalMs)
  const plan = useSession((s) => s.plan)
  const index = useSession((s) => s.index)
  const showTimes = useSession((s) => s.setup.showTimes)
  const end = useSession((s) => s.end)
  const read = (timeMs: number) => {
    const elapsed = sessionElapsedMs(plan, index, timeMs)
    const phase = phases[phaseAt(phases, elapsed)]
    const tone = phaseTone(intensityAt(phases, elapsed))
    return `${phase?.label ?? ''}|${tone}|${fmtDuration(Math.max(0, (phase?.endMs ?? 0) - elapsed))}|${fmtDuration(elapsed)}|${fmtDuration(sessionRemainingMs(plan, index, timeMs))}`
  }
  const [text, setText] = useState(() => read(live.get().timeMs))
  live.useLive((l) => setText(read(l.timeMs)), [plan, index, phases])
  const [label, tone, phaseLeft, elapsed, remaining] = text.split('|')
  return (
    <div className="sstrip">
      <span className="lbl">
        <Shuffle />
        <b>{t('player.sessionStrip.title')}</b>
        <span className={cx('phase-pill', `tone-${tone}`)}>{label}</span>
        {showTimes && <span className="faint">{t('player.sessionStrip.left', { time: phaseLeft ?? '' })}</span>}
      </span>
      {showTimes ? <PhaseStrip phases={phases} totalMs={totalMs} /> : <span />}
      {showTimes && (
        <span className="right">
          <b>{elapsed}</b> · {t('player.sessionStrip.left', { time: remaining ?? '' })}
        </span>
      )}
      <Button variant="ghost" className="end" onClick={() => end()}>
        {t('player.sessionStrip.end')}
      </Button>
    </div>
  )
}

import { X } from 'lucide-react'
import { useMemo } from 'react'
import { stats } from '@/editor/ops'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'

export function Inspector() {
  const t = useT()
  const lanes = useEditor((s) => s.lanes)
  const focused = useEditor((s) => s.focused)
  const selection = useEditor((s) => s.selection)
  const analysing = useEditor((s) => s.analysing)
  const selectNone = useEditor((s) => s.selectNone)
  const info = useMemo(() => {
    const lane = lanes.find((l) => l.axis === focused)
    if (!lane || selection.size === 0) return null
    return stats(lane.points.filter((p) => selection.has(p.at)))
  }, [lanes, focused, selection])
  return (
    <div className="ed-inspector">
      {info ? (
        <>
          <strong>{t('editor.inspector.points', { count: info.count })}</strong>
          <span>
            {t('editor.inspector.span')}<b>{(info.spanMs / 1000).toFixed(3)} s</b>
          </span>
          <span>
            {t('editor.inspector.depth')}<b>{Math.round(info.depth)}</b>
          </span>
          <span>
            {t('editor.inspector.avg')}<b>{Math.round(info.average)}/s</b>
          </span>
          <span>
            {t('editor.inspector.top')}<b>{Math.round(info.max)}/s</b>
          </span>
        </>
      ) : (
        <span>{analysing ? t('editor.inspector.analysing') : ''}</span>
      )}
      <span className="grow" />
      {info && (
        <button type="button" className="ed-btn" aria-label={t('editor.inspector.clearSelection')} title={t('editor.screen.withKey', { label: t('editor.inspector.clearSelection'), key: 'Esc' })} onClick={selectNone}>
          <X />
        </button>
      )}
    </div>
  )
}

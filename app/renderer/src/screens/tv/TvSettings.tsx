import { Cable, Play, Tv } from 'lucide-react'
import { useRef, useState, type ComponentType, type KeyboardEvent } from 'react'
import type { MessageKey } from '@shared/i18n'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { AxesGroup } from './settings/Axes'
import { DevicesGroup } from './settings/Devices'
import { HardwareDecodeGroup, PlaybackGroup } from './settings/Playback'
import { TvModeGroup } from './settings/TvMode'
import { UpscalingGroup } from './settings/Upscaling'

type GroupId = 'general' | 'playback' | 'devices'
const GROUPS: ReadonlyArray<{ id: GroupId; label: MessageKey; icon: ComponentType; body: ComponentType }> = [
  { id: 'general', label: 'tv.settings.general', icon: Tv, body: TvModeGroup },
  { id: 'playback', label: 'tv.settings.playback', icon: Play, body: PlaybackBody },
  { id: 'devices', label: 'tv.settings.devicesMotion', icon: Cable, body: DevicesBody },
]

function PlaybackBody() {
  const t = useT()
  return <><h3 className="eyebrow tv-rows-eyebrow">{t('tv.settings.video')}</h3><UpscalingGroup /><HardwareDecodeGroup /><h3 className="eyebrow tv-rows-eyebrow">{t('tv.settings.subtitles')}</h3><PlaybackGroup /></>
}

function DevicesBody() {
  const t = useT()
  return <><DevicesGroup /><h3 className="eyebrow tv-rows-eyebrow">{t('tv.settings.axisDefaults')}</h3><AxesGroup /></>
}

export function TvSettings() {
  const t = useT()
  const [group, setGroup] = useState<GroupId>('general')
  const list = useRef<HTMLDivElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  const current = GROUPS.find((g) => g.id === group) ?? GROUPS[0]
  if (!current) return null
  const Body = current.body
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    rows.current?.querySelector<HTMLElement>('[data-nav-first]:not([aria-disabled="true"]), [tabindex="0"]:not([aria-disabled="true"]), button:not(:disabled)')?.focus()
  }
  const onRowsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' && e.key !== 'Backspace') return
    e.preventDefault()
    e.stopPropagation()
    list.current?.querySelector<HTMLElement>(`[data-focus-key="group:${group}"]`)?.focus()
  }
  return (
    <div className="tv-settings" data-nav-main>
      <div ref={list} className="groups" role="tablist" aria-label={t('tv.settings.groups')} onKeyDown={onListKey}>
        {GROUPS.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={g.id === group} className={cx(g.id === group && 'on')} data-focus-key={`group:${g.id}`} data-nav-first={g.id === 'general' ? '' : undefined} onFocus={() => setGroup(g.id)} onClick={() => setGroup(g.id)}>
            <g.icon />
            {t(g.label)}
          </button>
        ))}
      </div>
      <div ref={rows} className="rows" role="tabpanel" onKeyDown={onRowsKey}>
        <h2>{t(current.label)}</h2>
        <Body key={group} />
      </div>
    </div>
  )
}

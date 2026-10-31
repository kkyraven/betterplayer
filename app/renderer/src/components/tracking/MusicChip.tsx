import * as Popover from '@radix-ui/react-popover'
import { Music } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MessageKey, Translate } from '@shared/i18n'
import type { MusicSignal } from '@shared/trackingRules'
import { Button } from '@/components/ui/Button'
import { useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'
import { MusicFillSelect } from './MusicFillSelect'
import './MusicChip.css'

const SIGNAL_TEXT: Record<Exclude<MusicSignal['kind'], 'hero-file'>, MessageKey> = {
  tag: 'tracking.music.signal.tag',
  folder: 'tracking.music.signal.folder',
  title: 'tracking.music.signal.title',
}

function musicSignalText(signal: MusicSignal, t: Translate): string {
  return signal.kind === 'hero-file' ? t('tracking.music.signal.heroFile') : t(SIGNAL_TEXT[signal.kind], { value: signal.text })
}

export function MusicChip({ overlay }: { overlay: HTMLDivElement | null }) {
  const t = useT()
  const changed = useTracking((s) => s.source === 'player' && (s.resolved?.musicChanged ?? false))
  const signal = useTracking((s) => s.musicSignal)
  const setNotMusic = useTracking((s) => s.setNotMusic)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      if (trigger.current?.closest('[data-chrome]')?.getAttribute('data-chrome') === 'shown') e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!changed) return null
  const reason = signal ? musicSignalText(signal, t) : undefined
  return (
    <>
      <span className="vsep" />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button ref={trigger} type="button" className="chip on music-chip" data-tooltip={reason}>
            <Music />
            {t('tracking.music.chip')}
          </button>
        </Popover.Trigger>
        {overlay && (
          <Popover.Portal container={overlay}>
            <Popover.Content
              className="music-menu"
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              aria-label={t('tracking.music.chip')}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter' || e.key.startsWith('Arrow')) e.stopPropagation()
              }}
            >
              <div className="hd">
                <b>{t('tracking.music.chip')}</b>
                {reason && <span>{reason}</span>}
              </div>
              <div className="row">
                <span>{t('settings.tracking.musicFill')}</span>
                <MusicFillSelect />
              </div>
              <div className="sep" />
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false)
                  setNotMusic()
                }}
              >
                {t('tracking.music.notMusic')}
              </Button>
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </>
  )
}

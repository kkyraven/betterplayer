import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ban, Check, ChevronDown, Scan } from 'lucide-react'
import { useState } from 'react'
import {
  HERO_DIRECTION_LABEL,
  HERO_DIRECTIONS,
  HERO_FLOURISH_DESC,
  HERO_FLOURISH_LABEL,
  HERO_FLOURISHES,
  TRACK_AXIS_IDS,
  type HeroColourRule,
  type HeroDirection,
  type HeroFlourish,
  type TrackAxisId,
} from '@shared/tracking'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'
import { FlourishGlyph } from './FlourishGlyph'

const ARROW: Record<HeroDirection, typeof ArrowLeft | null> = { auto: null, 'right-to-left': ArrowLeft, 'left-to-right': ArrowRight, 'top-down': ArrowDown, 'bottom-up': ArrowUp }

export function HeroControls({ stroke, colours = true }: { stroke: boolean; colours?: boolean }) {
  const t = useT()
  const zone = useTracking((s) => s.heroZone)
  const pickZone = useTracking((s) => s.pickHeroZone)
  const setZoneEdit = useTracking((s) => s.setZoneEdit)
  const direction = useTracking((s) => s.heroDirection)
  const setDirection = useTracking((s) => s.setHeroDirection)
  const found = useTracking((s) => s.hero?.found ?? null)
  const intensity = useTracking((s) => s.axes.L0.intensity)
  const setAxis = useTracking((s) => s.setAxis)
  const shown = (direction === 'auto' ? (found as HeroDirection | null) : direction) ?? null
  const Arrow = shown ? ARROW[shown] : null
  return (
    <>
      <Button
        className={cx(zone && 'active')}
        onClick={() => {
          pickZone()
          setZoneEdit(true)
        }}
      >
        <Scan />
        {zone ? t('tracking.hero.moveZone') : t('tracking.hero.pickZone')}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="chip region-pick">
            {Arrow && <Arrow />}
            {direction === 'auto' ? (shown ? t('common.auto') : t('tracking.hero.looking')) : t(HERO_DIRECTION_LABEL[direction])}
            <ChevronDown />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="track-menu" align="start" sideOffset={6}>
            {HERO_DIRECTIONS.map((d) => (
              <DropdownMenu.Item key={d} className="item" onSelect={() => setDirection(d)}>
                {t(HERO_DIRECTION_LABEL[d])}
                {direction === d && <Check className="right" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {colours && <ColoursPopover />}
      {stroke && (
        <>
          <span className="vsep" />
          <span className="lbl">{t('tracking.intensity')}</span>
          <div className="sl sens">
            <Slider value={[intensity * 100]} min={0} max={200} step={5} label={t('tracking.intensity')} onValueChange={([v]) => setAxis('L0', { intensity: (v ?? 100) / 100 })} />
          </div>
          <span className="v">{Math.round(intensity * 100)}%</span>
        </>
      )}
    </>
  )
}

function ColoursPopover() {
  const t = useT()
  const colours = useTracking((s) => s.hero?.colours)
  const shared = useTracking((s) => s.heroColours)
  const own = useTracking((s) => s.heroAxisColours)
  const axes = useTracking((s) => s.axes)
  const setColour = useTracking((s) => s.setHeroColour)
  const resetAxis = useTracking((s) => s.resetHeroAxis)
  const importHero = useTracking((s) => s.importHero)
  const exportHero = useTracking((s) => s.exportHero)
  const [picked, setPicked] = useState<TrackAxisId | null>(null)
  const [bad, setBad] = useState(false)
  const heroAxes = TRACK_AXIS_IDS.filter((id) => axes[id].source === 'hero')
  const first = heroAxes[0] ?? 'L0'
  const axis = picked && heroAxes.includes(picked) ? picked : first
  const target = axis === first ? null : axis
  const table = target ? own[target] : undefined
  const seen = (colours ?? []).filter((c) => c.seen > 0)
  const swatch = (bucket: number) => (bucket === 12 ? '#ffffff' : `hsl(${bucket * 30 + 15} 90% 62%)`)
  return (
    <Popover.Root onOpenChange={(open) => open && setBad(false)}>
      <Popover.Trigger asChild>
        <button type="button" className="chip region-pick">
          <span className="swatches">
            {seen.slice(0, 3).map((c) => (
              <i key={c.bucket} style={{ background: swatch(c.bucket) }} />
            ))}
          </span>
          {seen.length === 0 ? t('tracking.hero.noNotes') : t('tracking.hero.colours', { count: seen.length })}
          <ChevronDown />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="axes-pop colours-pop" align="start" sideOffset={6} collisionPadding={12}>
          <div className="ttl">
            {t('tracking.hero.coloursTitle')}
            {heroAxes.length > 1 && <Segmented options={heroAxes.map((id) => ({ value: id, label: id }))} value={axis} onChange={setPicked} label={t('tracking.axis')} />}
          </div>
          {seen.length === 0 && <div className="axnote">{t('tracking.hero.notesNote')}</div>}
          {seen.length > 0 && (
            <div className="chead">
              <span />
              <span>{t('tracking.colour')}</span>
              <span>{t('tracking.hero.depth')}</span>
              <span />
              <span>{t('tracking.hero.pattern')}</span>
              <span />
            </div>
          )}
          {seen.map((c) => {
            const rule: HeroColourRule = table?.[c.bucket] ?? shared[c.bucket] ?? { intensity: c.intensity, flourish: c.flourish as HeroFlourish, smooth: c.smooth, ignore: c.ignore }
            const set = (patch: Partial<HeroColourRule>) => setColour(target, c.bucket, patch)
            return (
              <div key={c.bucket} className="crow" data-ignored={rule.ignore || undefined}>
                <i className="sw" style={{ background: swatch(c.bucket) }} />
                <span className="name">
                  {c.name}
                  <span className="comp">{t('tracking.hero.seenCount', { count: c.seen })}</span>
                </span>
                <div className="sl">
                  <Slider value={[rule.intensity * 100]} min={0} max={200} step={5} label={t('tracking.hero.depthLabel', { name: c.name })} disabled={rule.ignore} onValueChange={([v]) => set({ intensity: (v ?? 60) / 100 })} />
                </div>
                <span className="v">{Math.round(rule.intensity * 100)}%</span>
                <PatternPicker name={c.name} rule={rule} onChange={set} />
                <button type="button" className={cx('ign', rule.ignore && 'on')} title={rule.ignore ? t('tracking.hero.useAgain') : t('tracking.hero.ignore')} aria-pressed={rule.ignore} onClick={() => set({ ignore: !rule.ignore })}>
                  <Ban />
                </button>
              </div>
            )
          })}
          <div className="tfoot">
            <span className="note">{bad ? t('tracking.hero.notSetupFile') : target ? (table ? t('tracking.hero.ownRules', { axis }) : t('tracking.hero.sameAs', { axis: first })) : t('tracking.savedForVideo')}</span>
            <div className="acts">
              {target && table && (
                <Button className="ghost" onClick={() => resetAxis(target)}>
                  {t('tracking.hero.resetTo', { axis: first })}
                </Button>
              )}
              <Button className="ghost" onClick={() => void importHero().then((ok) => setBad(!ok))}>
                {t('common.import')}
              </Button>
              <Button className="ghost" onClick={() => void exportHero()}>
                {t('common.export')}
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PatternPicker({ name, rule, onChange }: { name: string; rule: HeroColourRule; onChange: (patch: Partial<HeroColourRule>) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="chip region-pick pat" disabled={rule.ignore}>
          <FlourishGlyph flourish={rule.flourish} smooth={rule.smooth} />
          {t(HERO_FLOURISH_LABEL[rule.flourish])}
          <ChevronDown />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="track-menu pattern-menu" align="end" sideOffset={6} collisionPadding={12}>
          {HERO_FLOURISHES.map((f) => (
            <button
              key={f}
              type="button"
              className={cx('item', rule.flourish === f && 'on')}
              onClick={() => {
                onChange({ flourish: f })
                setOpen(false)
              }}
            >
              <FlourishGlyph flourish={f} smooth={rule.smooth} width={40} />
              <span className="t">
                <b>{t(HERO_FLOURISH_LABEL[f])}</b>
                <span>{t(HERO_FLOURISH_DESC[f])}</span>
              </span>
              {rule.flourish === f && <Check className="right" />}
            </button>
          ))}
          <div className="smooth">
            <span className="lbl">{t('tracking.hero.smooth')}</span>
            <div className="sl">
              <Slider value={[Math.round(rule.smooth * 100)]} step={5} label={t('tracking.hero.smoothingLabel', { name })} onValueChange={([v]) => onChange({ smooth: (v ?? 0) / 100 })} />
            </div>
            <span className="v">{Math.round(rule.smooth * 100)}%</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

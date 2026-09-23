import { ChevronRight, Plus, Scan } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  HERO_BUCKET_NAMES,
  colourHex,
  REGION_TARGET_LABEL,
  REGION_TARGETS,
  ZONE_HOLD_MAX_MS,
  ZONE_TRIGGER_LABEL,
  ZONE_TRIGGERS,
  defaultHeroMusicRule,
  describeEffect,
  describeTrigger,
  heroBucketColour,
  zoneName,
  type EffectZone,
  type ZoneTriggerKind,
} from '@shared/tracking'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Stepper } from '@/components/ui/Stepper'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'
import { HeroControls } from './HeroControls'
import { OverrideFields } from './OverrideFields'
import { ColourMatchFields } from './ColourMatchFields'
import './Advanced.css'

const unfolded = { advanced: false, hero: true, zones: true }

export function Advanced() {
  const t = useT()
  const [open, setOpen] = useState(unfolded.advanced)
  const toggle = () => {
    unfolded.advanced = !open
    setOpen(!open)
  }
  return (
    <div className="advanced">
      <button type="button" className="adv-fold" aria-expanded={open} onClick={toggle}>
        <ChevronRight className={cx('adv-chev', open && 'open')} />
        {t('tracking.advanced')}
      </button>
      {open && (
        <>
          <HeroSection />
          <ZonesSection />
          <FileActions />
        </>
      )}
    </div>
  )
}

interface SectionProps {
  id: 'hero' | 'zones'
  title: string
  sub: string
  on: boolean
  onToggle: (on: boolean) => void
  blocked?: string
  children: ReactNode
}

function Section({ id, title, sub, on, onToggle, blocked, children }: SectionProps) {
  const [open, setOpen] = useState(unfolded[id])
  const toggle = () => {
    unfolded[id] = !open
    setOpen(!open)
  }
  return (
    <section className="adv-section">
      <div className="adv-head">
        <button type="button" className="adv-fold" aria-expanded={open} onClick={toggle}>
          <ChevronRight className={cx('adv-chev', open && 'open')} />
          <strong>{title}</strong>
          <span className="adv-sub">{blocked ?? sub}</span>
        </button>
        <Switch label={title} checked={on} disabled={blocked !== undefined} onCheckedChange={onToggle} />
      </div>
      {open && on && <div className="adv-body">{children}</div>}
    </section>
  )
}

function HeroSection() {
  const t = useT()
  const music = useTracking((s) => s.heroMusic)
  const usable = useTracking((s) => Object.values(s.axes).some((a) => a.source === 'ai-music'))
  const setEnabled = useTracking((s) => s.setHeroMusicEnabled)
  const setRule = useTracking((s) => s.setHeroMusicRule)
  const seen = useTracking((s) => s.hero?.colours)
  const [bucket, setBucket] = useState(() => Number(Object.keys(music.rules)[0] ?? 0))
  const rule = music.rules[bucket]
  const name = rule?.match ? colourHex(rule.match.colour) : t(HERO_BUCKET_NAMES[bucket] ?? 'tracking.colour')
  return (
    <Section id="hero" title={t('tracking.hero.title')} sub={t('tracking.hero.sub')} on={music.enabled && usable} onToggle={setEnabled} blocked={usable ? undefined : t('tracking.hero.blocked')}>
      <div className="adv-row">
        <HeroControls stroke={false} colours={false} />
      </div>
      <div className="hero-colour-list" role="group" aria-label={t('tracking.hero.beatColour')}>
        {HERO_BUCKET_NAMES.map((colour, i) => {
          const match = music.rules[i]?.match
          const label = match ? colourHex(match.colour) : t(colour)
          return (
            <button type="button" key={colour} aria-label={music.rules[i] ? t('tracking.hero.configured', { label }) : label} title={label} aria-pressed={bucket === i} data-configured={music.rules[i] ? '' : undefined} onClick={() => setBucket(i)}>
              <i style={{ background: match ? colourHex(match.colour) : heroBucketColour(i) }} />
            </button>
          )
        })}
      </div>
      <div className="hero-colour-heading">
        <span>
          {rule?.match ? name : t('tracking.hero.seen', { name, count: seen?.find((c) => c.bucket === bucket)?.seen ?? 0 })}
        </span>
        <span className="hero-use-colour">
          {t('tracking.hero.useColour')} <Switch label={t('tracking.hero.useLabel', { name })} checked={!!rule} onCheckedChange={(on) => setRule(bucket, on ? defaultHeroMusicRule() : null)} />
        </span>
      </div>
      {rule && (
        <>
          <ColourMatchFields bucket={bucket} value={rule.match} name={name} onChange={(match) => setRule(bucket, { match })} />
          <div className="adv-grid">
            <div className="adv-field">
              <span>{t('tracking.hero.duration')}</span>
              <Stepper value={rule.durationMs / 1000} min={0.1} max={30} step={0.5} format={(v) => t('common.secondsShort', { value: Number(v.toFixed(1)) })} label={t('tracking.hero.durationLabel', { name })} onChange={(v) => setRule(bucket, { durationMs: v * 1000 })} />
            </div>
            <OverrideFields value={rule} name={name} onChange={(patch) => setRule(bucket, patch)} />
            <Button className="adv-reset" variant="ghost" onClick={() => setRule(bucket, { ...defaultHeroMusicRule(), match: undefined, estimMaxRelative: null, strokeSpeed: null, vibeMax: null })}>
              {t('tracking.hero.resetColour')}
            </Button>
          </div>
        </>
      )}
    </Section>
  )
}

function ZonesSection() {
  const t = useT()
  const enabled = useTracking((s) => s.zones.enabled)
  const setEnabled = useTracking((s) => s.setZonesEnabled)
  return (
    <Section id="zones" title={t('tracking.zones.title')} sub={t('tracking.zones.sub')} on={enabled} onToggle={setEnabled}>
      <ZonesBody />
    </Section>
  )
}

function ZonesBody() {
  const t = useT()
  const zones = useTracking((s) => s.zones.zones)
  const matches = useTracking((s) => s.zoneMatches)
  const addZone = useTracking((s) => s.addZone)
  const showZones = useTracking((s) => s.showZones)
  const setZoneEdit = useTracking((s) => s.setZoneEdit)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    showZones(true)
    return () => showZones(false)
  }, [showZones])
  return (
    <>
      {zones.length > 0 && (
        <div className="zone-head">
          <span />
          <span>{t('tracking.zone')}</span>
          <span>{t('tracking.zones.trigger')}</span>
          <span>{t('tracking.zones.effect')}</span>
          <span />
        </div>
      )}
      {zones.map((z, i) => {
        const m = matches.find((x) => x.id === z.id)
        const open = z.id === selected
        return (
          <Fragment key={z.id}>
            <button type="button" className={cx('zone-row', open && 'open')} aria-expanded={open} onClick={() => setSelected(open ? null : z.id)}>
              <ZoneSwatches zone={z} />
              <span className="zone-name">{zoneName(i, t)}</span>
              <span className="zone-text">{describeTrigger(z, t)}</span>
              <span className="zone-text">{describeEffect(z.effect, t)}</span>
              <i className={cx('zone-live', m?.active && 'on')} title={m?.active ? t('tracking.zones.matching') : m ? t('tracking.zones.shareNow', { share: Math.round(m.share * 100) }) : undefined} />
            </button>
            {open && <ZoneEditor zone={z} index={i} share={m?.share ?? 0} />}
          </Fragment>
        )
      })}
      <div className="adv-row zone-acts">
        {zones.length > 0 && (
          <Button variant="ghost" onClick={() => setZoneEdit(true)}>
            <Scan />
            {t('tracking.zones.move')}
          </Button>
        )}
        <Button onClick={() => setSelected(addZone())}>
          <Plus />
          {t('tracking.zones.add')}
        </Button>
      </div>
    </>
  )
}

function ZoneSwatches({ zone }: { zone: EffectZone }) {
  const trigger = zone.trigger
  return (
    <span className="zone-sw">
      {trigger.kind === 'part' ? (
        <i className="part">
          <Scan />
        </i>
      ) : (
        trigger.buckets.slice(0, 3).map((b) => <i key={b} style={{ background: trigger.matches?.[b] ? colourHex(trigger.matches[b].colour) : heroBucketColour(b) }} />)
      )}
    </span>
  )
}

function ZoneEditor({ zone, index, share }: { zone: EffectZone; index: number; share: number }) {
  const t = useT()
  const update = useTracking((s) => s.updateZone)
  const remove = useTracking((s) => s.removeZone)
  const detector = useTracking((s) => s.present.detector)
  const name = zoneName(index, t)
  const change = (patch: Partial<Omit<EffectZone, 'id'>>) => update(zone.id, patch)
  const setKind = (kind: ZoneTriggerKind) => change({ trigger: kind === 'colour' ? { kind, buckets: [] } : { kind, target: 'faces' } })
  const toggleBucket = (b: number) => {
    if (zone.trigger.kind !== 'colour') return
    const { buckets } = zone.trigger
    const matches = { ...zone.trigger.matches }
    delete matches[b]
    change({ trigger: { kind: 'colour', buckets: buckets.includes(b) ? buckets.filter((x) => x !== b) : [...buckets, b].sort((x, y) => x - y), matches } })
  }
  return (
    <div className="zone-edit">
      <div className="adv-grid">
        <div className="adv-col">
          <div className="adv-colhead">
            {t('tracking.zones.trigger')}
            <Segmented options={ZONE_TRIGGERS.map((k) => ({ value: k, label: t(ZONE_TRIGGER_LABEL[k]) }))} value={zone.trigger.kind} onChange={setKind} label={t('tracking.zones.triggerLabel', { name })} />
          </div>
          {zone.trigger.kind === 'colour' ? (
            <div className="zone-swatches" role="group" aria-label={t('tracking.zones.coloursLabel', { name })}>
              {HERO_BUCKET_NAMES.map((colour, b) => {
                const match = zone.trigger.kind === 'colour' ? zone.trigger.matches?.[b] : undefined
                const label = match ? colourHex(match.colour) : t(colour)
                return (
                  <button type="button" key={colour} title={label} aria-label={label} aria-pressed={zone.trigger.kind === 'colour' && zone.trigger.buckets.includes(b)} onClick={() => toggleBucket(b)}>
                    <i style={{ background: match ? colourHex(match.colour) : heroBucketColour(b) }} />
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="adv-field">
              <span>{t('tracking.zones.part')}</span>
              <Select label={t('tracking.zones.bodyPartLabel', { name })} value={zone.trigger.target} options={REGION_TARGETS.map((target) => ({ value: target, label: t(REGION_TARGET_LABEL[target]) }))} onChange={(target) => change({ trigger: { kind: 'part', target } })} />
            </div>
          )}
          {zone.trigger.kind === 'colour' && zone.trigger.buckets.map((b) => {
            const match = zone.trigger.kind === 'colour' ? zone.trigger.matches?.[b] : undefined
            const label = match ? colourHex(match.colour) : t(HERO_BUCKET_NAMES[b] ?? 'tracking.colour')
            return (
              <ColourMatchFields key={b} bucket={b} value={match} name={`${name} ${label}`} onChange={(match) => {
                if (zone.trigger.kind === 'colour') change({ trigger: { ...zone.trigger, matches: { ...zone.trigger.matches, [b]: match } } })
              }} />
            )
          })}
          {zone.trigger.kind === 'part' && !detector && <div className="adv-note">{t('tracking.zones.noDetector')}</div>}
          <div className="adv-field">
            <span>
              {t('tracking.zones.cover')}<em>{t('tracking.zones.shareNow', { share: Math.round(share * 100) })}</em>
            </span>
            <Stepper value={Math.round(zone.cover * 100)} max={100} label={t('tracking.zones.coverLabel', { name })} onChange={(v) => change({ cover: v / 100 })} />
          </div>
          <div className="adv-field">
            <span>{t('tracking.zones.hold')}</span>
            <Stepper value={zone.holdMs / 1000} min={0} max={ZONE_HOLD_MAX_MS / 1000} step={0.5} format={(v) => t('common.secondsShort', { value: Number(v.toFixed(1)) })} label={t('tracking.zones.holdLabel', { name })} onChange={(v) => change({ holdMs: v * 1000 })} />
          </div>
        </div>
        <div className="adv-col">
          <div className="adv-colhead">{t('tracking.zones.effect')}</div>
          <OverrideFields value={zone.effect} name={name} onChange={(patch) => change({ effect: { ...zone.effect, ...patch } })} />
        </div>
      </div>
      <div className="adv-row">
        <Button variant="ghost" className="remove" onClick={() => remove(zone.id)}>
          {t('common.remove')}
        </Button>
      </div>
    </div>
  )
}

function FileActions() {
  const t = useT()
  const importHero = useTracking((s) => s.importHero)
  const exportHero = useTracking((s) => s.exportHero)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const transfer = async (kind: 'import' | 'export') => {
    setBusy(true)
    setError('')
    try {
      if (kind === 'import') {
        if (!(await importHero())) setError(t('tracking.zones.importFailed'))
      } else await exportHero()
    } catch {
      setError(kind === 'import' ? t('tracking.zones.importFailed') : t('tracking.zones.exportFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="adv-file">
      <span role="status">{error || t('tracking.zones.fileNote')}</span>
      <Button variant="ghost" disabled={busy} onClick={() => void transfer('import')}>
        {t('common.import')}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void transfer('export')}>
        {t('common.export')}
      </Button>
    </div>
  )
}

import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isAdmin } from '@shared/account'
import type { MessageKey } from '@shared/i18n'
import { OS_LABELS, type AdminStats, type DayPoint, type Share } from '@shared/usage'
import { IconButton } from '@/components/ui/IconButton'
import { Segmented } from '@/components/ui/Segmented'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import './admin.css'

const WINDOWS = [
  { value: '30', label: 'admin.window.30' },
  { value: '90', label: 'admin.window.90' },
  { value: '365', label: 'admin.window.year' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey }>
type Days = (typeof WINDOWS)[number]['value']

export function AdminScreen() {
  const t = useT()
  const me = useAccount((s) => s.status.me)
  const [days, setDays] = useState<Days>('90')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const admin = isAdmin(me)

  useEffect(() => {
    if (!admin) return
    let live = true
    setError(null)
    invoke('admin:stats', Number(days)).then(
      (s) => live && setStats(s),
      (e: unknown) => {
        if (!live) return
        setStats(null)
        setError(ipcMessage(e))
      },
    )
    return () => {
      live = false
    }
  }, [admin, days, tick])

  if (!admin) return null
  return (
    <div className="page admin">
      <div className="page-hd">
        <h1>{t('screen.admin')}</h1>
        <span className="spacer" />
        <Segmented value={days} onChange={setDays} options={WINDOWS.map((w) => ({ value: w.value, label: t(w.label) }))} label={t('admin.window')} />
        <IconButton label={t('common.refresh')} onClick={() => setTick((t) => t + 1)}>
          <RefreshCw />
        </IconButton>
      </div>
      {error && <div className="admin-error">{error}</div>}
      {stats && (
        <>
          <div className="admin-tiles">
            <Tile label={t('admin.installs')} value={stats.totals.installs} />
            <Tile label={t('admin.signedIn')} value={stats.totals.signedIn} sub={pct(stats.totals.signedIn, stats.totals.installs)} />
            <Tile label={t('admin.premium')} value={stats.totals.premium} sub={t('admin.ofAccounts', { count: stats.totals.users })} />
            <Tile label={t('admin.today')} value={stats.totals.dau} />
            <Tile label={t('admin.days7')} value={stats.totals.wau} />
            <Tile label={t('admin.window.30')} value={stats.totals.mau} />
          </div>
          <div className="admin-grid">
            <Chart title={t('admin.activePerDay')} days={stats.days} pick={(d) => d.active} kind="line" />
            <Chart title={t('admin.newPerDay')} days={stats.days} pick={(d) => d.installs} kind="bar" />
            <Shares title={t('admin.platform')} rows={stats.os.map((s) => ({ ...s, key: OS_LABELS[s.key] ?? s.key }))} />
            <Shares title={t('admin.version')} rows={stats.versions} />
            <Features stats={stats} />
          </div>
        </>
      )}
    </div>
  )
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '')
const fmt = (n: number) => n.toLocaleString()

function Tile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="admin-tile">
      <span className="admin-tile-l">{label}</span>
      <span className="admin-tile-v">{fmt(value)}</span>
      {sub && <span className="admin-tile-s">{sub}</span>}
    </div>
  )
}

const W = 600
const H = 160
const PAD = { top: 10, right: 8, bottom: 22, left: 30 }

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })}`
}

function Chart({ title, days, pick, kind }: { title: string; days: DayPoint[]; pick: (d: DayPoint) => number; kind: 'line' | 'bar' }) {
  const t = useT()
  const [hover, setHover] = useState<number | null>(null)
  const values = days.map(pick)
  const max = Math.max(1, ...values)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (days.length > 1 ? (i / (days.length - 1)) * innerW : innerW / 2)
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH
  const slot = days.length > 0 ? innerW / days.length : innerW
  const ticks = [0, Math.floor(days.length / 2), days.length - 1].filter((i, n, a) => i >= 0 && a.indexOf(i) === n)
  const current = hover !== null ? days[hover] : undefined
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <section className="admin-card">
      <header>
        <h2>{title}</h2>
        <span className="admin-card-v">{current ? `${dayLabel(current.day)}: ${fmt(pick(current))}` : kind === 'bar' ? t('admin.total', { count: fmt(total) }) : t('admin.todayValue', { count: fmt(values.at(-1) ?? 0) })}</span>
      </header>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="admin-chart"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - box.left) / box.width) * W
          const i = Math.round(((px - PAD.left) / innerW) * (days.length - 1))
          setHover(i >= 0 && i < days.length ? i : null)
        }}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={PAD.left - 6} y={y(max * f) + 3} className="axis" textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} className="axis" textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>
            {days[i] ? dayLabel(days[i].day) : ''}
          </text>
        ))}
        {kind === 'bar'
          ? values.map((v, i) => {
              const bw = Math.max(1, slot - 2)
              return <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, y(0) - y(v))} rx={Math.min(2, bw / 2)} className={hover === i ? 'bar on' : 'bar'} />
            })
          : values.length === 1
            ? <circle cx={x(0)} cy={y(values[0] ?? 0)} r={4} className="dot" />
            : (
              <>
                <path d={`${values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} L${x(values.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`} className="area" />
                <path d={values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} className="line" />
              </>
            )}
        {current && kind === 'line' && (
          <>
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={y(0)} className="cross" />
            <circle cx={x(hover!)} cy={y(pick(current))} r={4} className="dot" />
          </>
        )}
      </svg>
    </section>
  )
}

function Shares({ title, rows }: { title: string; rows: Share[] }) {
  const t = useT()
  const total = rows.reduce((a, r) => a + r.count, 0)
  return (
    <section className="admin-card">
      <header>
        <h2>{title}</h2>
      </header>
      {rows.length === 0 && <div className="admin-empty">{t('admin.nothingYet')}</div>}
      <ul className="admin-bars">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="k">{r.key}</span>
            <span className="track">
              <span className="fill" style={{ width: `${total > 0 ? (r.count / total) * 100 : 0}%` }} />
            </span>
            <span className="n">
              {fmt(r.count)} <span className="faint">{pct(r.count, total)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Features({ stats }: { stats: AdminStats }) {
  const t = useT()
  const top = Math.max(1, ...stats.features.map((f) => f.installs))
  return (
    <section className="admin-card wide">
      <header>
        <h2>{t('admin.features', { count: stats.window })}</h2>
        <span className="admin-card-v">{t('admin.installsUses')}</span>
      </header>
      {stats.features.length === 0 && <div className="admin-empty">{t('admin.nothingYet')}</div>}
      <ul className="admin-bars">
        {stats.features.map((f) => (
          <li key={f.feature}>
            <span className="k mono">{f.feature}</span>
            <span className="track">
              <span className="fill" style={{ width: `${(f.installs / top) * 100}%` }} />
            </span>
            <span className="n">
              {fmt(f.installs)} <span className="faint">{fmt(f.uses)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

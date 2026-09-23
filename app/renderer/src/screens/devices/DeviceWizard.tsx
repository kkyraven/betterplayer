import { ArrowLeft, ArrowRight, Bluetooth, Check, CloudLightning, Globe, Plug, Radio, RefreshCw, Smartphone, Usb, Zap, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BleDevice, ProbedPort, ToyScanState } from 'bp-engine'
import type { MessageKey } from '@shared/i18n'
import { readShockers, type OpenShockOwnJson, type OpenShockShocker } from '@shared/openshock'
import { OPENSHOCK_URL, OPENSHOCK_USER_AGENT, RESTIM_URL, defaultOpenShockTrigger, type HandyHosting, type OutputConfig } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { bleScan, listPorts, probeSerial, toyDevices, toyScan } from '@/engine/client'
import { cx } from '@/lib/cx'
import { outputName, testMove, useDevices } from '@/state/devices'
import { t, useT } from '@/state/i18n'
import { isOwnIntiface, useIntifaceStatus } from '@/state/intiface'
import { useUi } from '@/state/ui'
import { featureSummary, ossmText, statusDot, statusText } from './status'
import { watchSocket } from './socketProbe'
import './DeviceWizard.css'
import { PiShockConnect } from './PiShockConnect'

const INTIFACE_URL = 'ws://127.0.0.1:12345'

type Tile = 'serial' | 'bluetooth' | 'network' | 'restim' | 'intiface' | 'handy' | 'howl' | 'openshock' | 'pishock'

const TILES: ReadonlyArray<{ id: Tile; icon: LucideIcon; name: MessageKey; sub: MessageKey }> = [
  { id: 'serial', icon: Usb, name: 'devices.wizard.tile.serial', sub: 'devices.wizard.tile.serialSub' },
  { id: 'bluetooth', icon: Bluetooth, name: 'devices.wizard.tile.bluetooth', sub: 'devices.wizard.tile.bluetoothSub' },
  { id: 'network', icon: Radio, name: 'devices.wizard.tile.network', sub: 'devices.wizard.tile.networkSub' },
  { id: 'restim', icon: Zap, name: 'devices.wizard.tile.restim', sub: 'devices.wizard.tile.restimSub' },
  { id: 'intiface', icon: Plug, name: 'devices.wizard.tile.intiface', sub: 'devices.wizard.tile.intifaceSub' },
  { id: 'handy', icon: Globe, name: 'devices.wizard.tile.handy', sub: 'devices.wizard.tile.handySub' },
  { id: 'howl', icon: Smartphone, name: 'devices.wizard.tile.howl', sub: 'devices.wizard.tile.howlSub' },
  { id: 'pishock', icon: CloudLightning, name: 'devices.wizard.tile.pishock', sub: 'common.supporterOnly' },
  { id: 'openshock', icon: CloudLightning, name: 'devices.wizard.tile.openshock', sub: 'devices.wizard.tile.openshockSub' },
]

export function DeviceWizard() {
  const t = useT()
  const open = useUi((s) => s.deviceWizard)
  const setOpen = useUi((s) => s.setDeviceWizard)
  return (
    <Modal open={open} onOpenChange={setOpen} title={t('devices.wizard.title')}>
      {open && <Wizard onClose={() => setOpen(false)} />}
    </Modal>
  )
}

function Wizard({ onClose }: { onClose: () => void }) {
  const t = useT()
  const add = useDevices((s) => s.add)
  const intiface = useIntifaceStatus()
  const [tile, setTile] = useState<Tile>('serial')
  const [addedId, setAddedId] = useState<number | null>(null)
  const step = addedId === null ? 1 : 2

  const connect = async (config: OutputConfig) => {
    setAddedId(await add(config))
  }

  return (
    <div className="wiz">
      <div className="steps">
        <span className={cx('step', step === 1 && 'on', step > 1 && 'done')}>
          <span className="n">{step > 1 ? <Check /> : '1'}</span>{t('devices.wizard.stepConnect')}
        </span>
        <span className={cx('step', step === 2 && 'on')}>
          <span className="n">2</span>{t('devices.wizard.stepTest')}
        </span>
      </div>
      {addedId === null ? (
        <>
          <div>
            <h1>{t('devices.wizard.title')}</h1>
            <p>{t('devices.wizard.pickHow')}</p>
          </div>
          <div className="tiles" role="radiogroup" aria-label={t('devices.wizard.connection')}>
            {TILES.map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={tile === option.id} className={cx('tile', tile === option.id && 'on')} onClick={() => setTile(option.id)}>
                <span className="ic">
                  <option.icon />
                </span>
                <b>{t(option.name)}</b>
                <span>{t(option.sub)}</span>
              </button>
            ))}
          </div>
          {tile === 'serial' && <SerialPanel onConnect={connect} />}
          {tile === 'bluetooth' && <BluetoothPanel onConnect={connect} />}
          {tile === 'network' && <NetworkPanel onConnect={connect} />}
          {tile === 'handy' && <HandyPanel onConnect={connect} />}
          {tile === 'howl' && <HowlPanel onConnect={connect} />}
          {tile === 'openshock' && <OpenShockConnect onConnect={connect} />}
          {tile === 'pishock' && <PiShockConnect onConnect={connect} />}
          {tile === 'restim' && <SocketPanel key="restim" label="restim" defaultUrl={RESTIM_URL} config={(url) => ({ kind: 'websocket', profile: 'restim', url, name: 'restim' })} onConnect={connect} />}
          {tile === 'intiface' && <SocketPanel key="intiface" label="Intiface Central" defaultUrl={INTIFACE_URL} config={(url) => ({ kind: 'buttplug', profile: 'stroker', url })} onConnect={connect} isOwn={(url) => isOwnIntiface(url, intiface)} />}
          <div className="ft">
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <TestStep id={addedId} onBack={() => setAddedId(null)} onDone={onClose} />
      )}
    </div>
  )
}

const HIDDEN_PORTS = /Bluetooth-Incoming-Port|debug-console|Buds|AirPods/i

function candidatePorts(inUse: Set<string>): string[] {
  return listPorts().filter((p) => !inUse.has(p) && !HIDDEN_PORTS.test(p) && !p.includes('/tty.'))
}

function SerialPanel({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  const inUse = new Set(outputs.map((o) => o.config.path).filter((p): p is string => Boolean(p)))
  const [ports] = useState(() => candidatePorts(inUse))
  const [probed, setProbed] = useState<ProbedPort[] | null>(null)
  const [manual, setManual] = useState(ports[0] ?? '')
  const [baud, setBaud] = useState('115200')

  useEffect(() => {
    let live = true
    if (ports.length === 0) {
      setProbed([])
      return
    }
    void probeSerial(ports, 3000).then((r) => {
      if (live) setProbed(r)
    })
    return () => {
      live = false
    }
  }, [ports])

  const found = probed?.filter((p) => p.device || p.tcode) ?? []
  const connect = (path: string, device?: string) => onConnect({ kind: 'serial', profile: 'stroker', path, baud: Number(baud) || 115200, name: device ? device.split(/[\s-]/)[0] : undefined })

  return (
    <div className="panel">
      {probed === null && ports.map((p) => <Row key={p} name={p.split('/').pop() ?? p} sub={p} status={t('devices.wizard.checking')} dot="warn" />)}
      {found.map((p) => (
        <Row key={p.path} name={p.device ?? (p.path.split('/').pop() ?? p.path)} sub={[p.path, p.tcode].filter(Boolean).join(' · ')} status={t('devices.wizard.found')} dot="" ok>
          <Button variant="primary" onClick={() => void connect(p.path, p.device)}>
            {t('devices.wizard.connect')}
          </Button>
        </Row>
      ))}
      {probed !== null && found.length === 0 && <Row name={ports.length === 0 ? t('devices.wizard.noPorts') : t('devices.wizard.noBoard')} sub={ports.length === 0 ? t('devices.wizard.plugIn') : t('devices.wizard.powerOn')} dot="idle" />}
      <div className="prow">
        <span className="dot idle" />
        <span className="sub">{t('devices.wizard.notListed')}</span>
        <span className="spacer" />
        <select className="input mono port-pick" value={manual} aria-label={t('devices.wizard.port')} onChange={(e) => setManual(e.target.value)}>
          {ports.length === 0 && <option value="">{t('devices.wizard.noPorts')}</option>}
          {ports.map((p) => (
            <option key={p} value={p}>
              {p.split('/').pop()}
            </option>
          ))}
        </select>
        <input className="input mono baud" inputMode="numeric" aria-label={t('devices.wizard.baud')} value={baud} onChange={(e) => setBaud(e.target.value)} />
        <Button disabled={!manual} onClick={() => void connect(manual)}>
          {t('devices.wizard.connect')}
        </Button>
      </div>
    </div>
  )
}

const SCAN_SECONDS = 5
const TOY_POLL_MS = 500

function BluetoothPanel({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  const [found, setFound] = useState<BleDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanId, setScanId] = useState(0)
  const [toys, setToys] = useState<ToyScanState>({ devices: [] })
  useEffect(() => {
    let live = true
    setFound(null)
    setError(null)
    bleScan(SCAN_SECONDS)
      .then((r) => live && setFound(r.filter((d) => d.kind !== 'other')))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [scanId])
  useEffect(() => {
    toyScan(true)
    const read = () => {
      const next = toyDevices()
      setToys((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    read()
    const timer = window.setInterval(read, TOY_POLL_MS)
    return () => {
      window.clearInterval(timer)
      toyScan(false)
    }
  }, [])
  const connect = (d: BleDevice) => {
    const device = d.name || d.address
    if (d.kind === 'coyote') return onConnect({ kind: 'coyote', profile: 'stroker', device, strengthA: 0, strengthB: 0 })
    return onConnect({ kind: d.kind === 'ossm' ? 'ossm' : 'ble', profile: 'stroker', device })
  }
  const bleKind = (d: BleDevice) => (d.kind === 'coyote' ? 'Coyote v3' : d.kind === 'ossm' ? 'OSSM' : 'TCode')
  const taken = new Set(outputs.filter((o) => o.config.kind === 'toy').map((o) => o.config.address))
  const toyRows = toys.devices.filter((d) => !d.bound && !taken.has(d.address))
  const nothing = found !== null && found.length === 0 && toyRows.length === 0
  return (
    <div className="panel">
      {found === null && !error && <Row name={t('devices.wizard.scanning')} sub={t('devices.seconds', { value: SCAN_SECONDS })} dot="warn" />}
      {error && <Row name={t('devices.wizard.bluetoothUnavailable')} sub={error} dot="idle" />}
      {toys.error && !error && <Row name={t('devices.wizard.toysUnavailable')} sub={toys.error} dot="idle" />}
      {toyRows.map((d) => (
        <Row key={`toy-${d.index}`} name={d.name} sub={featureSummary(d.features)} status={t('devices.wizard.found')} dot="" ok>
          <Button variant="primary" onClick={() => void onConnect({ kind: 'toy', profile: 'stroker', device: d.name, address: d.address })}>
            {t('devices.wizard.connect')}
          </Button>
        </Row>
      ))}
      {found?.map((d) => (
        <Row key={d.address} name={d.name || d.address} sub={[bleKind(d), d.address].join(' · ')} status={t('devices.wizard.found')} dot="" ok>
          <Button variant="primary" onClick={() => void connect(d)}>
            {t('devices.wizard.connect')}
          </Button>
        </Row>
      ))}
      {nothing && <Row name={t('devices.wizard.noDevice')} sub={t('devices.wizard.powerOnScan')} dot="idle" />}
      {found !== null && (
        <div className="prow">
          <span className="spacer" />
          <Button variant="ghost" onClick={() => setScanId((n) => n + 1)}>
            <RefreshCw />
            {t('devices.wizard.scanAgain')}
          </Button>
        </div>
      )}
    </div>
  )
}

const HOSTINGS: ReadonlyArray<{ value: HandyHosting; label: MessageKey }> = [
  { value: 'cloud', label: 'devices.wizard.hosting.cloud' },
  { value: 'lan', label: 'devices.wizard.hosting.lan' },
]

function HandyPanel({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const [key, setKey] = useState('')
  const [appKey, setAppKey] = useState('')
  const [hosting, setHosting] = useState<HandyHosting>('cloud')
  const valid = key.trim().length >= 4
  return (
    <form
      className="panel net"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void onConnect({ kind: 'handy', profile: 'stroker', key: key.trim(), appKey: appKey.trim() || undefined, hosting })
      }}
    >
      <div className="prow">
        <Field label={t('devices.wizard.connectionKey')}>
          <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label={t('devices.wizard.appKey')} hint={t('common.optional')}>
          <input className="input mono" value={appKey} onChange={(e) => setAppKey(e.target.value)} />
        </Field>
        <Segmented options={HOSTINGS.map((h) => ({ value: h.value, label: t(h.label) }))} value={hosting} onChange={setHosting} label={t('devices.wizard.scriptHosting')} />
        <Button type="submit" variant="primary" disabled={!valid}>
          {t('devices.wizard.connect')}
        </Button>
      </div>
    </form>
  )
}

const HOWL_KEY_LENGTH = 12

function HowlPanel({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const [host, setHost] = useState('')
  const [key, setKey] = useState('')
  const valid = host.trim().length > 0 && key.trim().length === HOWL_KEY_LENGTH
  return (
    <form
      className="panel net"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void onConnect({ kind: 'howl', profile: 'stroker', host: host.trim(), key: key.trim().toUpperCase() })
      }}
    >
      <div className="prow">
        <Field label={t('devices.wizard.phoneAddress')}>
          <input className="input mono" placeholder="192.168.1.30" value={host} onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label={t('devices.wizard.key')}>
          <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={!valid}>
          {t('devices.wizard.connect')}
        </Button>
      </div>
    </form>
  )
}

const OPENSHOCK_TOKEN_MIN = 16
const OPENSHOCK_LOOKUP_DELAY_MS = 500

async function listShockers(token: string): Promise<OpenShockShocker[]> {
  const res = await fetch(`${OPENSHOCK_URL}/1/shockers/own`, { headers: { OpenShockToken: token, Accept: 'application/json', 'User-Agent': OPENSHOCK_USER_AGENT } })
  if (res.status === 401 || res.status === 403) throw new Error(t('devices.wizard.tokenRejected'))
  if (!res.ok) throw new Error(t('devices.wizard.openshockAnswered', { status: res.status }))
  return readShockers((await res.json()) as OpenShockOwnJson)
}

function OpenShockConnect({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  const [token, setToken] = useState('')
  const [shockers, setShockers] = useState<OpenShockShocker[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = token.trim()
  const asking = trimmed.length >= OPENSHOCK_TOKEN_MIN
  useEffect(() => {
    setShockers(null)
    setError(null)
    if (!asking) return
    let live = true
    const timer = window.setTimeout(() => {
      listShockers(trimmed)
        .then((r) => live && setShockers(r))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    }, OPENSHOCK_LOOKUP_DELAY_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [trimmed, asking])
  const taken = new Set(outputs.filter((o) => o.config.kind === 'openshock').map((o) => o.config.shocker))
  const rows = shockers?.filter((s) => !taken.has(s.id)) ?? []
  return (
    <div className="panel shock-setup">
      <div className="prow">
        <Field label={t('devices.wizard.apiToken')} hint={t('devices.shock.scriptHint')}>
          <input className="input mono" value={token} placeholder={t('devices.wizard.tokenHint')} onChange={(e) => setToken(e.target.value)} />
        </Field>
      </div>
      {asking && shockers === null && !error && <Row name={t('devices.wizard.checking')} sub="" dot="warn" />}
      {error && <Row name={error} sub="" dot="idle" />}
      {rows.map((s) => (
        <Row key={s.id} name={s.name} sub={[s.hub, s.model].filter(Boolean).join(' · ')} status={s.paused ? t('devices.wizard.paused') : t('devices.wizard.found')} dot={s.paused ? 'warn' : ''} ok={!s.paused}>
          <Button variant="primary" onClick={() => void onConnect({ kind: 'openshock', profile: 'stroker', url: OPENSHOCK_URL, token: trimmed, shocker: s.id, name: s.name, trigger: defaultOpenShockTrigger() })}>
            {t('devices.wizard.connect')}
          </Button>
        </Row>
      ))}
      {shockers !== null && rows.length === 0 && <Row name={t('devices.wizard.noShockers')} sub="" dot="idle" />}
    </div>
  )
}

type NetKind = 'udp' | 'tcp' | 'websocket'
const NET_KINDS: ReadonlyArray<{ value: NetKind; label: string }> = [
  { value: 'udp', label: 'UDP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'websocket', label: 'WebSocket' },
]

function NetworkPanel({ onConnect }: { onConnect: (c: OutputConfig) => Promise<void> }) {
  const t = useT()
  const [kind, setKind] = useState<NetKind>('udp')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('8000')
  const [url, setUrl] = useState('ws://')
  const p = Number(port)
  const config: OutputConfig | null =
    kind === 'websocket' ? (/^wss?:\/\/.+/.test(url) ? { kind, profile: 'stroker', url } : null) : host && Number.isInteger(p) && p > 0 && p < 65536 ? { kind, profile: 'stroker', host, port: p } : null
  return (
    <form
      className="panel net"
      onSubmit={(e) => {
        e.preventDefault()
        if (config) void onConnect(config)
      }}
    >
      <div className="prow">
        <Segmented options={NET_KINDS} value={kind} onChange={setKind} label={t('devices.wizard.protocol')} />
        {kind === 'websocket' ? (
          <Field label={t('devices.wizard.url')}>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label={t('devices.wizard.host')}>
              <input className="input mono" placeholder="192.168.1.20" value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label={t('devices.wizard.port')}>
              <input className="input mono port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </>
        )}
        <Button type="submit" variant="primary" disabled={config === null}>
          {t('devices.wizard.connect')}
        </Button>
      </div>
    </form>
  )
}

function SocketPanel({ label, defaultUrl, config, onConnect, isOwn }: { label: string; defaultUrl: string; config: (url: string) => OutputConfig; onConnect: (c: OutputConfig) => Promise<void>; isOwn?: (url: string) => boolean }) {
  const t = useT()
  const [url, setUrl] = useState(defaultUrl)
  const [running, setRunning] = useState<boolean | null>(null)
  const own = isOwn?.(url) ?? false
  useEffect(() => {
    if (own) return
    setRunning(null)
    return watchSocket(url, setRunning)
  }, [url, own])
  const valid = /^wss?:\/\/.+/.test(url)
  const status = own ? t('devices.wizard.thisApp') : running === null ? t('devices.wizard.checking') : running ? t('devices.wizard.found') : t('devices.wizard.notRunning')
  return (
    <div className="panel">
      <Row name={label} sub={<input className="input mono url" aria-label={t('devices.wizard.address')} value={url} onChange={(e) => setUrl(e.target.value)} />} status={status} dot={own ? 'idle' : running ? '' : running === null ? 'warn' : 'idle'} ok={!own && running === true}>
        <Button variant="primary" disabled={!valid || own} onClick={() => void onConnect(config(url))}>
          {t('devices.wizard.connect')}
        </Button>
      </Row>
    </div>
  )
}

function Row({ name, sub, status, dot, ok = false, children }: { name: string; sub: React.ReactNode; status?: string; dot: string; ok?: boolean; children?: React.ReactNode }) {
  return (
    <div className="prow">
      <span className={`dot ${dot}`} />
      <span className="lbl">{name}</span>
      <span className="sub mono">{sub}</span>
      <span className="spacer" />
      {status && <span className={cx('pill-status', ok && 'ok')}>{status}</span>}
      {children}
    </div>
  )
}

function TestStep({ id, onBack, onDone }: { id: number; onBack: () => void; onDone: () => void }) {
  const t = useT()
  const output = useDevices((s) => s.outputs.find((o) => o.id === id))
  const state = useDevices((s) => s.states[id])
  const [moving, setMoving] = useState(false)
  if (!output) return null
  const move = async () => {
    setMoving(true)
    await testMove(output)
    setMoving(false)
  }
  const [verb, doing] = (output.config.kind === 'openshock' || output.config.kind === 'pishock') ? [t('devices.wizard.pulse'), t('devices.wizard.pulsing')] : [t('devices.wizard.move'), t('devices.wizard.moving')]
  return (
    <>
      <div>
        <h1>{t('devices.wizard.testIt')}</h1>
      </div>
      <div className="panel">
        <Row name={state?.device ?? outputName(output.config)} sub={[state?.address ?? output.config.kind, state?.tcode, state?.ossm && ossmText(state)].filter(Boolean).join(' · ')} status={statusText(state)} dot={statusDot(state?.status)} ok={state?.status === 'connected'}>
          <Button variant="primary" disabled={moving || state?.status !== 'connected'} onClick={() => void move()}>
            {moving ? doing : verb}
          </Button>
        </Row>
      </div>
      <div className="ft">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t('common.back')}
        </Button>
        <span className="spacer" />
        <Button variant="primary" onClick={onDone}>
          {t('common.done')}
          <ArrowRight />
        </Button>
      </div>
    </>
  )
}

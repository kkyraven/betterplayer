import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleCheck, Columns2, Download, ExternalLink, Folder, FolderOpen, Info, Lock, MonitorPlay, Play, Plus, RefreshCw, SlidersHorizontal, Tag, Tv, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { IpcChannel, IpcContract } from '@shared/ipc'
import { UPSCALER_LABELS } from '@shared/settings'
import { TAGGER_MODEL } from '@shared/tagging'
import photo from '@/assets/first-start/mountain.jpg'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Logo } from '@/components/ui/Logo'
import { LanguageSelect } from '@/components/ui/LanguageSelect'
import { enhanceCapabilities } from '@/engine/client'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { checkSupporter, isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import { electron } from '@/node'
import { ipcMessage } from '@/lib/errors'
import { useLibrary } from '@/state/library'
import { percent, useModels } from '@/state/models'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'
import { STEPS, bestUpscaler, folderName } from './steps'
import './firstStart.css'

interface Nav {
  next: () => void
  back: () => void
  finish: () => void
}

export function FirstStart() {
  const t = useT()
  const [step, setStep] = useState(0)
  const premium = useAccount(isPremium)
  const [offer, setOffer] = useState(false)
  const [visited, setVisited] = useState<ReadonlySet<number>>(() => new Set())
  const body = useRef<HTMLDivElement>(null)
  const update = useSettings((s) => s.update)
  const setFirstStart = useUi((s) => s.setFirstStart)
  const setScreen = useUi((s) => s.setScreen)

  const go = (to: number, done = false) => {
    if (done) setVisited((v) => new Set(v).add(step))
    setStep(Math.max(0, Math.min(STEPS.length - 1, to)))
  }
  const nav: Nav = {
    next: () => go(step + 1, true),
    back: () => go(step - 1),
    finish: () => {
      setScreen('library')
      setFirstStart(false)
      void update((s) => ({ ...s, general: { ...s.general, setupDone: true } }))
    },
  }
  useEffect(() => {
    body.current?.querySelector('h1')?.focus({ preventScroll: true })
  }, [step, offer])

  const page = offer ? 'supporter' : STEPS[step]?.id ?? 'welcome'
  const finishAccount = () => premium ? nav.finish() : setOffer(true)
  return (
    <div className={cx('fs', `fs-on-${page}`)}>
      <header className="titlebar fs-titlebar">
        <Logo className="logo" variant="lockup" scheme={offer ? 'dark' : undefined} />
      </header>
      <div className="fs-body" ref={body}>
        {!offer && <nav className="fs-steps" aria-label={t('firstStart.progress')}>
          {STEPS.map((s, i) => {
            const done = visited.has(i) && i !== step
            return (
              <Fragment key={s.id}>
                {i > 0 && <span className="fs-step-gap" aria-hidden />}
                <button type="button" className={cx('fs-step', done && 'done')} aria-current={i === step ? 'step' : undefined} aria-label={s.optional ? t('firstStart.step.optional', { label: t(s.label) }) : undefined} onClick={() => go(i)}>
                  <span className="fs-step-n">{done ? <Check /> : i + 1}</span>
                  {t(s.label)}
                </button>
              </Fragment>
            )
          })}
        </nav>}
        <div className="fs-content">
          {page === 'welcome' && <WelcomePage nav={nav} />}
          {page === 'folders' && <FoldersPage nav={nav} />}
          {page === 'upscaling' && <UpscalingPage nav={nav} />}
          {page === 'tagging' && <TaggingPage nav={nav} />}
          {page === 'supporter' && <SupporterPage nav={{ ...nav, back: () => setOffer(false) }} />}
          {page === 'account' && <AccountPage nav={{ ...nav, next: finishAccount }} />}
        </div>
      </div>
      {!offer && <footer className="fs-foot">
        <span>{t(step === 0 ? 'firstStart.foot.first' : 'firstStart.foot.later')}</span>
        <FootStatus />
      </footer>}
    </div>
  )
}

function Heading({ title, description, optional = false }: { title: string; description?: string; optional?: boolean }) {
  const t = useT()
  return (
    <header className="fs-heading">
      {optional && <span className="fs-eyebrow">{t('firstStart.optional')}</span>}
      <h1 tabIndex={-1}>{title}</h1>
      {description && <p className="fs-description">{description}</p>}
    </header>
  )
}

function Actions({ back, primary, skip }: { back: () => void; primary: ReactNode; skip?: ReactNode }) {
  const t = useT()
  return (
    <footer className="fs-actions">
      <Button variant="ghost" onClick={back}>
        <ArrowLeft />
        {t('common.back')}
      </Button>
      <div className="fs-actions-right">
        {skip}
        {primary}
      </div>
    </footer>
  )
}

function WelcomePage({ nav }: { nav: Nav }) {
  const t = useT()
  return (
    <article className="fs-page">
      <header className="fs-heading">
        <h1 tabIndex={-1}>{t('firstStart.welcome.title')}</h1>
        <Logo variant="lockup" className="fs-lockup" />
      </header>
      <div className="fs-route" aria-hidden>
        <span>
          <Folder />
          {t('firstStart.welcome.media')}
        </span>
        <ChevronRight />
        <span>
          <SlidersHorizontal />
          {t('firstStart.welcome.setup')}
        </span>
        <ChevronRight />
        <span>
          <Play />
          {t('firstStart.welcome.play')}
        </span>
      </div>
      <footer className="fs-actions fs-actions-stack">
        <LanguageSelect className="fs-language" />
        <Button variant="primary" onClick={nav.next}>
          {t('firstStart.welcome.start')}
          <ArrowRight />
        </Button>
        <Button variant="ghost" onClick={nav.finish}>
          {t('firstStart.welcome.skip')}
        </Button>
      </footer>
    </article>
  )
}

function FoldersPage({ nav }: { nav: Nav }) {
  const t = useT()
  const roots = useLibrary((s) => s.roots)
  const addRoot = useLibrary((s) => s.addRoot)
  const removeRoot = useLibrary((s) => s.removeRoot)
  const [picking, setPicking] = useState(false)
  const pick = async () => {
    setPicking(true)
    try {
      await addRoot()
    } finally {
      setPicking(false)
    }
  }
  return (
    <article className="fs-page">
      <Heading title={t('firstStart.folders.title')} description={t('firstStart.folders.description')} />
      <div className="fs-feature">
        {roots.length === 0 ? (
          <button type="button" className="fs-drop" disabled={picking} onClick={() => void pick()}>
            <FolderOpen />
            <strong>{t('firstStart.folders.add')}</strong>
            <span>{t('firstStart.folders.selectHint')}</span>
          </button>
        ) : (
          <>
            <ul className="fs-folders">
              {roots.map((root) => {
                const name = root.kind === 'folder' ? folderName(root.path) : root.name || root.path
                return (
                  <li key={root.id} className="fs-folder">
                    <Folder />
                    <span className="fs-folder-t">
                      <strong>{name}</strong>
                      <small title={root.path}>{root.path}</small>
                    </span>
                    <span className="fs-folder-s">{t(root.error ? 'firstStart.folders.unavailable' : 'firstStart.folders.added')}</span>
                    <IconButton size="sm" label={t('firstStart.folders.remove', { name })} onClick={() => void removeRoot(root.id)}>
                      <X />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
            <Button variant="ghost" className="fs-add-more" disabled={picking} onClick={() => void pick()}>
              <Plus />
              {t('firstStart.folders.add')}
            </Button>
          </>
        )}
        <p className="fs-fine">
          <Folder />
          {t('firstStart.folders.stay')}
        </p>
      </div>
      <Actions
        back={nav.back}
        skip={
          roots.length === 0 && (
            <Button variant="ghost" onClick={nav.next}>
              {t('firstStart.folders.later')}
            </Button>
          )
        }
        primary={
          <Button variant="primary" disabled={roots.length === 0} onClick={nav.next}>
            {t('common.continue')}
            <ArrowRight />
          </Button>
        }
      />
    </article>
  )
}

function UpscalingPage({ nav }: { nav: Nav }) {
  const t = useT()
  const upscaler = useSettings((s) => s.settings?.upscaling.upscaler ?? 'off')
  const setUpscaling = usePlayer((s) => s.setUpscaling)
  const best = bestUpscaler(enhanceCapabilities, process.platform)
  const enabled = upscaler !== 'off'
  const choose = (on: boolean) => {
    setUpscaling({ upscaler: on ? best : 'off' })
    nav.next()
  }
  return (
    <article className="fs-page">
      <Heading title={t('firstStart.upscaling.title')} description={t('firstStart.upscaling.description')} optional />
      <div className="fs-feature">
        <Comparison caption={best === 'sharp' ? t('firstStart.upscaling.standard') : t('firstStart.upscaling.available', { name: t(UPSCALER_LABELS[best]) })} />
        <p className="fs-fine">{t('firstStart.upscaling.power')}</p>
        {enabled && (
          <p className="fs-fine">
            <Check />
            {t('firstStart.upscaling.enabled', { name: t(UPSCALER_LABELS[upscaler]) })}
          </p>
        )}
      </div>
      <Actions
        back={nav.back}
        skip={
          <Button variant="ghost" onClick={() => (enabled ? choose(false) : nav.next())}>
            {t(enabled ? 'firstStart.upscaling.turnOff' : 'firstStart.skipForNow')}
          </Button>
        }
        primary={
          enabled ? (
            <Button variant="primary" onClick={nav.next}>
              {t('common.continue')}
              <ArrowRight />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => choose(true)}>
              {t('firstStart.upscaling.title')}
              <ArrowRight />
            </Button>
          )
        }
      />
    </article>
  )
}

function Comparison({ caption }: { caption: string }) {
  const t = useT()
  const [at, setAt] = useState(50)
  return (
    <figure className="fs-compare-wrap">
      <div className="fs-compare">
        <img src={photo} alt="" />
        <div className="fs-compare-soft" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>
          <img src={photo} alt="" />
        </div>
        <span className="fs-compare-line" style={{ left: `${at}%` }}>
          <span className="fs-compare-handle">
            <Columns2 />
          </span>
        </span>
        <span className="fs-compare-label original">{t('firstStart.upscaling.original')}</span>
        <span className="fs-compare-label upscaled">{t('firstStart.upscaling.upscaled')}</span>
        <input type="range" min={5} max={95} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label={t('firstStart.upscaling.compare')} />
      </div>
      <figcaption className="fs-compare-caption">
        <span className="fs-capability">
          <Check />
          {caption}
        </span>
        <span>{t('firstStart.upscaling.preview')}</span>
      </figcaption>
    </figure>
  )
}

const TAGGER_FILES = TAGGER_MODEL.files.map((f) => f.file)

function TaggingPage({ nav }: { nav: Nav }) {
  const t = useT()
  const autoTag = useSettings((s) => s.settings?.library.autoTag ?? true)
  const update = useSettings((s) => s.update)
  const download = useModels((s) => s.downloads[TAGGER_MODEL.id])
  const start = useModels((s) => s.download)
  const cancel = useModels((s) => s.cancel)
  const [installed, setInstalled] = useState(false)
  const status = download?.status
  useEffect(() => {
    let current = true
    void invoke('models:status', TAGGER_FILES).then((files) => {
      if (current) setInstalled(TAGGER_FILES.every((f) => files[f]))
    })
    return () => {
      current = false
    }
  }, [status])

  const setAutoTag = (on: boolean) => update((s) => ({ ...s, library: { ...s.library, autoTag: on } }))
  const enable = async () => {
    await setAutoTag(true)
    if (installed) nav.next()
    else void start(TAGGER_MODEL)
  }
  const running = status === 'running'
  const failed = status === 'error'
  const enabled = installed && autoTag
  const sample = (
    <div className="fs-tag-card">
      <div className="fs-tag-picture">
        <img src={photo} alt="" />
        <span className="fs-tag-duration">02:48</span>
      </div>
      <div className="fs-tag-meta">
        <strong>Mountain.mp4</strong>
        <span className="fs-tags">
          {(['firstStart.tagging.sample.outdoors', 'firstStart.tagging.sample.sky', 'firstStart.tagging.sample.scenery'] as const).map((tag) => (
            <span key={tag} className="fs-tag">
              <Tag />
              {t(tag)}
            </span>
          ))}
        </span>
      </div>
    </div>
  )
  return (
    <article className="fs-page">
      <Heading title={t('firstStart.tagging.title')} description={t('firstStart.tagging.description')} optional />
      <div className="fs-feature">
        {download?.status === 'error' ? (
          <div className="fs-state">
            <Download />
            <strong>{t('firstStart.tagging.downloadFailed')}</strong>
            <p>{download.error}</p>
            <Button onClick={() => void start(TAGGER_MODEL)}>{t('common.tryAgain')}</Button>
          </div>
        ) : (
          <>
            {sample}
            {download?.status === 'running' ? (
              <div className="fs-download">
                <div className="fs-download-hd">
                  <strong>{t('firstStart.tagging.downloading')}</strong>
                  <span className="fs-download-pct">{percent(download)}%</span>
                </div>
                <div className="fs-meter" role="progressbar" aria-label={t('firstStart.tagging.downloadLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(download)}>
                  <span style={{ width: `${percent(download)}%` }} />
                </div>
                <div className="fs-download-detail">
                  <span>
                    {t('firstStart.tagging.progress', { done: Math.round(download.done / 1024 / 1024), total: TAGGER_MODEL.sizeMb })}
                  </span>
                  <span>{t('firstStart.tagging.continueAnyTime')}</span>
                </div>
                <p className="fs-download-note">{t('firstStart.tagging.autoNote')}</p>
              </div>
            ) : (
              <div className="fs-tag-download">
                <span>
                  <Lock />
                  {t('firstStart.tagging.local')}
                </span>
                <span>
                  {installed ? t('firstStart.tagging.installed') : <>{t('firstStart.tagging.size', { size: TAGGER_MODEL.sizeMb })} · <a href={TAGGER_MODEL.sourceUrl} className="link" onClick={(e) => { e.preventDefault(); void electron.shell.openExternal(TAGGER_MODEL.sourceUrl) }}>{t('firstStart.tagging.link')}</a></>}
                </span>
              </div>
            )}
            {enabled && (
              <p className="fs-fine fs-ready">
                <CircleCheck />
                {t('firstStart.tagging.enabled')}
              </p>
            )}
          </>
        )}
      </div>
      <Actions
        back={nav.back}
        skip={
          running ? (
            <Button variant="ghost" onClick={() => void cancel(TAGGER_MODEL.id)}>
              {t('firstStart.tagging.cancelDownload')}
            </Button>
          ) : enabled ? (
            <Button
              variant="ghost"
              onClick={() => {
                void setAutoTag(false)
                nav.next()
              }}
            >
              {t('firstStart.upscaling.turnOff')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={nav.next}>
              {t('firstStart.skipForNow')}
            </Button>
          )
        }
        primary={
          running || failed || enabled ? (
            <Button variant="primary" onClick={nav.next}>
              {t('common.continue')}
              <ArrowRight />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void enable()}>
              {t(installed ? 'firstStart.tagging.enable' : 'firstStart.tagging.downloadEnable')}
              {installed ? <ArrowRight /> : <Download />}
            </Button>
          )
        }
      />
    </article>
  )
}

function AccountPage({ nav }: { nav: Nav }) {
  const t = useT()
  const status = useAccount((s) => s.status)
  const signed = status.me !== null
  const waiting = status.state === 'signingIn'
  const failed = status.state === 'error' && !signed
  const reopen = async () => {
    await invoke('account:cancelLogin')
    call('account:login')
  }
  return (
    <article className="fs-page">
      <Heading title={t(signed ? 'firstStart.account.ready' : 'firstStart.account.title')} description={signed ? undefined : t('firstStart.account.description')} optional={!signed} />
      <div className="fs-feature">
        {signed ? (
          <div className="fs-state">
            <CircleCheck />
            <strong>{t('firstStart.account.signedIn')}</strong>
            <p>{status.me?.email}</p>
          </div>
        ) : waiting ? (
          <div className="fs-state">
            <ExternalLink />
            <strong>{t('firstStart.account.finishInBrowser')}</strong>
            <p>{t('firstStart.account.returnHere')}</p>
            <Button onClick={() => void reopen()}>{t('firstStart.account.openAgain')}</Button>
          </div>
        ) : failed ? (
          <div className="fs-state">
            <Info />
            <strong>{t('firstStart.account.failed')}</strong>
            <p>{status.error ?? t('firstStart.account.failedHint')}</p>
          </div>
        ) : (
          <>
            <div className="fs-account-art" aria-hidden>
              <span className="fs-account-device">
                <MonitorPlay />
              </span>
              <RefreshCw />
              <span className="fs-account-device">
                <Tv />
              </span>
            </div>
            <ul className="fs-benefits">
              <li>
                <RefreshCw />
                {t('firstStart.account.sync')}
              </li>
              <li>
                <Play />
                {t('firstStart.account.watchTogether')}
              </li>
            </ul>
            <p className="fs-fine">
              <ExternalLink />
              {t('firstStart.account.inBrowser')}
            </p>
          </>
        )}
      </div>
      <Actions
        back={nav.back}
        skip={
          signed ? null : waiting ? (
            <Button variant="ghost" onClick={() => call('account:cancelLogin')}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={nav.next}>
              {t('firstStart.skipForNow')}
            </Button>
          )
        }
        primary={
          signed ? (
            <Button variant="primary" onClick={nav.next}>
              {t(status.me?.premium ? 'firstStart.account.openLibrary' : 'common.continue')}
              <ArrowRight />
            </Button>
          ) : waiting ? (
            <Button variant="primary" onClick={nav.next}>
              {t('firstStart.skipForNow')}
              <ArrowRight />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => call('account:login')}>
              {t(failed ? 'common.tryAgain' : 'firstStart.account.title')}
              <ExternalLink />
            </Button>
          )
        }
      />
    </article>
  )
}

function SupporterPage({ nav }: { nav: Nav }) {
  const t = useT()
  const status = useAccount((s) => s.status)
  const premium = status.me?.premium === true
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const refresh = async () => {
    setBusy(true)
    setMessage(null)
    setMessage(await checkSupporter())
    setBusy(false)
  }
  const subscribe = async () => {
    setMessage(null)
    try {
      await electron.shell.openExternal(SUBSCRIBE_URL)
    } catch (error) {
      setMessage(ipcMessage(error))
    }
  }
  return (
    <article className="fs-supporter">
      <div className="fs-supporter-content">
        <span className="fs-eyebrow">{t('firstStart.supporter.eyebrow')}</span>
        <h1 tabIndex={-1}>{premium ? t('firstStart.supporter.unlocked') : <>{t('firstStart.supporter.unlock')} <span className="fs-supporter-price">{t('firstStart.supporter.from')} <strong>{SUPPORTER_PRICE}</strong> {t('firstStart.supporter.perMonth')}</span></>}</h1>
        <ul className="fs-supporter-features">
          <li>{t('firstStart.supporter.feature.ai')}</li>
          <li>{t('firstStart.supporter.feature.adBlock')}</li>
          <li>{t('firstStart.supporter.feature.watchTogether')}</li>
        </ul>
        <div className="fs-supporter-actions">
          {premium ? <Button variant="primary" onClick={nav.finish}>{t('firstStart.account.openLibrary')}<ArrowRight /></Button> : <>
            <Button variant="primary" onClick={() => void subscribe()}>{t('firstStart.supporter.become')}<ExternalLink /></Button>
            <Button variant="ghost" onClick={nav.finish}>{t('firstStart.supporter.continueFree')}</Button>
          </>}
        </div>
        {message && <p className="fs-fine" role="status">{message}</p>}
      </div>
      <footer className="fs-supporter-foot">
        <Button variant="ghost" onClick={nav.back}>{t('common.back')}</Button>
        <span>KINKY<span>RAVEN</span></span>
        {!premium && <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{t(busy ? 'update.status.checking' : status.me ? 'firstStart.supporter.refresh' : 'firstStart.account.title')}</Button>}
      </footer>
    </article>
  )
}

function FootStatus() {
  const t = useT()
  const download = useModels((s) => s.downloads[TAGGER_MODEL.id])
  const start = useModels((s) => s.download)
  const autoTag = useSettings((s) => s.settings?.library.autoTag ?? true)
  const roots = useLibrary((s) => s.roots.length)
  const scanning = useLibrary((s) => s.progress.scanning)
  let content: ReactNode = null
  if (download?.status === 'running') {
    content = (
      <span className="fs-foot-download">
        <Download />
        <span>{t('firstStart.tagging.model')}</span>
        <span className="fs-meter" role="progressbar" aria-label={t('firstStart.tagging.downloadLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(download)}>
          <span style={{ width: `${percent(download)}%` }} />
        </span>
        <span className="fs-download-pct">{percent(download)}%</span>
      </span>
    )
  } else if (download?.status === 'error') {
    content = (
      <>
        <Download />
        {t('firstStart.tagging.downloadFailed')}
        <Button variant="ghost" onClick={() => void start(TAGGER_MODEL)}>
          {t('common.retry')}
        </Button>
      </>
    )
  } else if (download?.status === 'done' && autoTag) {
    content = (
      <>
        <CircleCheck />
        {t('firstStart.tagging.enabled')}
      </>
    )
  } else if (roots > 0 && scanning) {
    content = (
      <>
        <Folder />
        {t('firstStart.scanning', { count: roots })}
      </>
    )
  }
  return (
    <span className="fs-foot-status" role="status">
      {content}
    </span>
  )
}

function call<C extends IpcChannel>(channel: C, ...args: Parameters<IpcContract[C]>) {
  void invoke(channel, ...args).catch(() => undefined)
}

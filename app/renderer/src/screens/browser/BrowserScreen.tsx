import { ArrowLeft, ArrowRight, Bookmark, Crosshair, Home, Lock, Maximize, Minimize, Plus, RefreshCw, Shield, ShieldOff, Star, Volume2, VolumeX, X } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { SUBSCRIBE_URL } from '@shared/account'
import { isPremium, useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { electron } from '@/node'
import { TrackBar } from '@/components/tracking/TrackBar'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { cx } from '@/lib/cx'
import { useBrowser } from '@/state/browser'
import { useUi } from '@/state/ui'
import { invoke, on } from '@/ipc'
import { SiteIcon, StartPage, siteName } from './StartPage'
import { BookmarksBar } from './BookmarksBar'
import { REVEAL_ZONE_PX } from '@shared/browser'
import { FAPTAP_HOST } from '@shared/tracking'
import { FaptapDialog } from './FaptapDialog'
import { useSettings } from '@/state/settings'
import { useTracking } from '@/state/tracking'
import './browser.css'

type Overlay = `site:${string}` | 'adblock' | 'faptap'


export function BrowserScreen() {
  const tabs = useBrowser((s) => s.tabs)
  const initialized = useBrowser((s) => s.initialized)
  const open = useBrowser((s) => s.open)
  const setBounds = useBrowser((s) => s.setBounds)
  const page = useRef<HTMLDivElement>(null)
  const opening = useRef(false)
  const fullscreen = useUi((s) => s.fullscreen)
  const active = tabs.find((tab) => tab.active)
  const startPage = !active || active.url === 'about:blank' || !active.url
  const chrome = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const menuRequest = useRef(0)
  const showChrome = !fullscreen || revealed || overlay !== null
  const bookmarksBar = useBrowser((s) => s.bookmarksBar)
  const menuSite = overlay?.startsWith('site:') ? overlay.slice('site:'.length) : null
  const site = active ? siteName(active.url) : ''
  const faptapHelpSeen = useSettings((s) => s.settings?.intiface.faptapHelpSeen ?? true)
  const updateSettings = useSettings((s) => s.update)

  const openMenu = async (next: Overlay | null) => {
    const request = ++menuRequest.current
    if (next === null) {
      setOverlay(null)
      setPreview(null)
      return
    }
    const captured = next === 'faptap' ? null : !startPage && overlay === null ? await invoke('browser:preview') : preview
    if (request !== menuRequest.current) return
    setPreview(captured)
    setOverlay(next)
  }
  useEffect(() => {
    ++menuRequest.current
    setOverlay(null)
    setPreview(null)
    return () => { ++menuRequest.current }
  }, [active?.id, site])
  const faptap = site === FAPTAP_HOST
  useEffect(() => {
    if (faptap && !faptapHelpSeen) void openMenu('faptap')
  }, [faptap, faptapHelpSeen, active?.id])
  const closeFaptap = () => {
    void openMenu(null)
    if (!faptapHelpSeen) void updateSettings((s) => ({ ...s, intiface: { ...s.intiface, faptapHelpSeen: true } }))
  }

  useEffect(() => { setRevealed(false) }, [fullscreen])
  useEffect(() => {
    if (!fullscreen) return
    let timer = 0
    const keep = () => { window.clearTimeout(timer); timer = 0; setRevealed(true) }
    const hide = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        const editing = document.hasFocus() && chrome.current?.contains(document.activeElement) && document.activeElement?.matches('input, textarea, [contenteditable="true"]')
        if (!overlay && !editing && !chrome.current?.matches(':hover')) setRevealed(false)
      }, 350)
    }
    const move = (event: MouseEvent) => {
      if (event.clientY <= REVEAL_ZONE_PX || chrome.current?.contains(event.target as Node)) keep()
      else hide()
    }
    const off = on('browser:pointer', ({ y }) => { if (y <= REVEAL_ZONE_PX) keep(); else hide() })
    window.addEventListener('mousemove', move)
    window.addEventListener('focusout', hide)
    return () => {
      window.clearTimeout(timer)
      off()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('focusout', hide)
    }
  }, [fullscreen, overlay])
  useEffect(() => {
    if (initialized && tabs.length === 0 && !opening.current) {
      opening.current = true
      void open().finally(() => { opening.current = false })
    }
  }, [initialized, tabs.length, open])

  useLayoutEffect(() => {
    const el = page.current
    if (!el) return
    if (startPage || overlay !== null) {
      void setBounds(null)
      return
    }
    let mounted = true
    const report = () => {
      if (!mounted || !el.isConnected) return
      const r = el.getBoundingClientRect()
      void setBounds({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      mounted = false
      ro.disconnect()
      window.removeEventListener('resize', report)
      void setBounds(null)
    }
  }, [setBounds, startPage, overlay, showChrome, active?.id])

  return (
    <div className={cx('bwrap', fullscreen && 'bfullscreen')}>
      {fullscreen && <div className="breveal" onMouseEnter={() => setRevealed(true)} />}
      <div ref={chrome} className="bchrome" hidden={!showChrome}>
        <Tabs />
        <AddressRow adBlockOpen={overlay === 'adblock'} onAdBlockOpen={(open) => void openMenu(open ? 'adblock' : null)} />
        {(startPage || bookmarksBar) && <BookmarksBar openSite={menuSite} onOpenSite={(site) => void openMenu(site === null ? null : `site:${site}`)} />}
        <TrackBar variant="browser" />
      </div>
      <div ref={page} className="bpage">
        {startPage ? <StartPage key={active?.id} /> : preview && overlay !== null ? <img className="bpreview" src={preview} alt="" /> : null}
      </div>
      <FaptapDialog open={overlay === 'faptap'} onClose={closeFaptap} />
    </div>
  )
}

const TAB_DRAG_PX = 4

function Tabs() {
  const translate = useT()
  const tabs = useBrowser((s) => s.tabs)
  const activate = useBrowser((s) => s.activate)
  const close = useBrowser((s) => s.close)
  const open = useBrowser((s) => s.open)
  const reorder = useBrowser((s) => s.reorder)
  const setMuted = useBrowser((s) => s.setMuted)
  const [drag, setDrag] = useState<{ id: number; from: number; to: number; dx: number; pitch: number } | null>(null)

  const press = (event: ReactPointerEvent<HTMLDivElement>, id: number, from: number) => {
    if (event.button !== 0 || tabs.length < 2 || (event.target instanceof Element && event.target.closest('.tab-close, .tab-audio'))) return
    const el = event.currentTarget
    const strip = el.parentElement
    const tabElements = [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    for (const tab of tabElements) {
      for (const animation of tab.getAnimations()) animation.finish()
    }
    const startX = event.clientX
    const pointerId = event.pointerId
    let current: { to: number; pitch: number } | null = null
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const move = (ev: PointerEvent) => {
      if (!current) {
        if (Math.abs(ev.clientX - startX) < TAB_DRAG_PX) return
        const [first, second] = [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].map((tab) => tab.getBoundingClientRect())
        const pitch = first && second ? second.left - first.left : 0
        if (pitch <= 0) return
        current = { to: from, pitch }
        el.setPointerCapture(pointerId)
      }
      const dx = Math.max(-from * current.pitch, Math.min((tabs.length - 1 - from) * current.pitch, ev.clientX - startX))
      current.to = from + Math.round(dx / current.pitch)
      setDrag({ id, from, to: current.to, dx, pitch: current.pitch })
    }
    const up = () => {
      cleanup()
      if (!current) return
      const positions = tabElements.map((tab) => tab.getBoundingClientRect().left)
      for (const tab of tabElements) tab.style.transition = 'none'
      flushSync(() => {
        setDrag(null)
        if (current && current.to !== from) void reorder(id, current.to)
      })
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      tabElements.forEach((tab, index) => {
        const dx = positions[index]! - tab.getBoundingClientRect().left
        tab.style.removeProperty('transition')
        if (reducedMotion || Math.abs(dx) < 0.5) return
        tab.animate([
          { transform: `translateX(${dx}px)` },
          { transform: 'translateX(0)' },
        ], { duration: 150, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
      })
    }
    const cancel = () => {
      cleanup()
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const shift = (index: number) => {
    if (!drag) return 0
    if (index > drag.from && index <= drag.to) return -drag.pitch
    if (index < drag.from && index >= drag.to) return drag.pitch
    return 0
  }

  return (
    <div className={cx('tabs', drag && 'dragging')} role="tablist">
      {tabs.map((t, index) => {
        const dragged = drag?.id === t.id
        const x = dragged ? drag.dx : shift(index)
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={t.active ? 0 : -1}
            aria-selected={t.active}
            aria-busy={t.loading}
            className={cx('tab', t.active && 'on', dragged && 'dragged')}
            style={x ? { transform: `translateX(${x}px)` } : undefined}
            onClick={() => void activate(t.id)}
            onPointerDown={(event) => press(event, t.id, index)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                const toIndex = Math.max(0, Math.min(tabs.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))
                if (event.altKey) void reorder(t.id, toIndex)
                else {
                  const next = tabs[toIndex]
                  if (next) void activate(next.id)
                  const siblings = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')
                  siblings?.[toIndex]?.focus()
                }
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                void activate(t.id)
              }
            }}
          >
            {t.loading ? <RefreshCw className="tab-loading" size={12} aria-hidden="true" /> : <SiteIcon url={t.url} icon={t.favicon} size={12} />}
            <span>{t.url === 'about:blank' ? translate('browser.tab.new') : t.title || t.url || translate('browser.tab.new')}</span>
            {(t.audible || t.muted) && (
              <button
                type="button"
                className={cx('tab-audio', t.muted && 'muted')}
                aria-label={translate('browser.tab.mute')}
                aria-pressed={t.muted}
                onClick={(e) => {
                  e.stopPropagation()
                  void setMuted(t.id, !t.muted)
                }}
              >
                {t.muted ? <VolumeX /> : <Volume2 />}
              </button>
            )}
            <button
              type="button"
              className="tab-close"
              aria-label={translate('browser.tab.close')}
              onClick={(e) => {
                e.stopPropagation()
                void close(t.id)
              }}
            >
              <X />
            </button>
          </div>
        )
      })}
      <IconButton
        label={translate('browser.tab.new')}
        size="sm"
        onClick={async () => {
          await open()
          document.querySelector<HTMLInputElement>('.bchrome .url input')?.focus()
        }}
      >
        <Plus />
      </IconButton>
    </div>
  )
}

function AddressRow({ adBlockOpen, onAdBlockOpen }: { adBlockOpen: boolean; onAdBlockOpen: (open: boolean) => void }) {
  const t = useT()
  const tab = useBrowser((s) => s.tabs.find((t) => t.active) ?? null)
  const navigate = useBrowser((s) => s.navigate)
  const back = useBrowser((s) => s.back)
  const forward = useBrowser((s) => s.forward)
  const reload = useBrowser((s) => s.reload)
  const stopLoading = useBrowser((s) => s.stop)
  const source = useTracking((s) => s.source)
  const start = useTracking((s) => s.start)
  const stop = useTracking((s) => s.stop)
  const data = useBrowser((s) => s.startData)
  const toggleBookmark = useBrowser((s) => s.toggleBookmark)
  const bookmarksBar = useBrowser((s) => s.bookmarksBar)
  const setBookmarksBar = useBrowser((s) => s.setBookmarksBar)
  const fullscreen = useUi((s) => s.fullscreen)
  const toggleFullscreen = useUi((s) => s.toggleFullscreen)
  const bookmarked = data?.bookmarks.some((bookmark) => bookmark.url === tab?.url) ?? false
  const canBookmark = !!tab && /^https?:/.test(tab.url)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const shown = editing ? text : (tab?.url === 'about:blank' ? '' : tab?.url) ?? ''
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim()) navigate(text.trim())
    setEditing(false)
    e.currentTarget.querySelector('input')?.blur()
  }
  const tracking = source === 'browser'
  return (
    <form className="addr" onSubmit={submit}>
      <IconButton label={t('common.back')} disabled={!tab?.canGoBack} onClick={back}>
        <ArrowLeft />
      </IconButton>
      <IconButton label={t('browser.addr.forward')} disabled={!tab?.canGoForward} onClick={forward}>
        <ArrowRight />
      </IconButton>
      <IconButton label={t(tab?.loading ? 'common.stop' : 'browser.addr.reload')} onClick={tab?.loading ? stopLoading : reload}>
        {tab?.loading ? <X /> : <RefreshCw />}
      </IconButton>
      <IconButton label={t('browser.addr.startPage')} onClick={() => void navigate('about:blank')}><Home /></IconButton>
      <label className="url">
        <Lock />
        <input
          value={shown}
          placeholder={t('browser.addr.placeholder')}
          spellCheck={false}
          onFocus={(e) => {
            setText(tab?.url === 'about:blank' ? '' : (tab?.url ?? ''))
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setText(e.target.value)}
        />
        {tab && tab.blocked > 0 && <span className="chip blocked">{t('browser.addr.blocked', { count: tab.blocked })}</span>}
      </label>
      <IconButton label={bookmarked ? t('browser.addr.removeBookmark') : t('browser.addr.bookmark')} disabled={!canBookmark} aria-pressed={bookmarked} className={cx(bookmarked && 'on')} onClick={() => tab && void toggleBookmark(tab.url, tab.title)}>
        <Star fill={bookmarked ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton label={bookmarksBar ? t('browser.addr.hideBookmarksBar') : t('browser.addr.showBookmarksBar')} aria-pressed={bookmarksBar} className={cx(bookmarksBar && 'on')} onClick={() => setBookmarksBar(!bookmarksBar)}>
        <Bookmark fill={bookmarksBar ? 'currentColor' : 'none'} />
      </IconButton>
      <AdBlockButton open={adBlockOpen} onOpenChange={onAdBlockOpen} />
      <IconButton label={fullscreen ? t('browser.addr.exitFullscreen') : t('browser.addr.fullscreen')} onClick={() => void toggleFullscreen()}>
        {fullscreen ? <Minimize /> : <Maximize />}
      </IconButton>
      {tab?.video?.present && (
        <Button variant={tracking ? 'default' : 'primary'} className={cx(tracking && 'on')} onClick={() => (tracking ? stop() : void start('browser'))}>
          <Crosshair />
          {tracking ? t('browser.addr.tracking') : t('browser.addr.track')}
        </Button>
      )}
    </form>
  )
}

function AdBlockButton({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const data = useBrowser((s) => s.startData)
  const setAdBlockEnabled = useBrowser((s) => s.setAdBlockEnabled)
  const premium = useAccount(isPremium)
  const signedOut = useAccount((s) => s.status.state === 'out')
  const on = premium && data?.adBlockEnabled === true
  const button = (
    <button type="button" className="badblock" aria-label={t('browser.adBlock.label')} aria-pressed={on} disabled={!data} onClick={premium ? () => data && void setAdBlockEnabled(!data.adBlockEnabled) : undefined}>
      {on ? <Shield /> : <ShieldOff />}
      <span>{on ? t('browser.adBlock.on') : t('browser.adBlock.off')}</span>
    </button>
  )
  if (premium) return button
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="badblock-menu" align="end" sideOffset={5} collisionPadding={12}>
          <strong>{t('browser.adBlock.premiumTitle')}</strong>
          <p>{t('browser.adBlock.premiumBody')}</p>
          <Button variant="primary" onClick={() => void electron.shell.openExternal(SUBSCRIBE_URL)}>
            {t('browser.adBlock.subscribe')}
          </Button>
          {signedOut && (
            <button type="button" className="badblock-login" onClick={() => void invoke('account:login')}>
              {t('browser.adBlock.login')}
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

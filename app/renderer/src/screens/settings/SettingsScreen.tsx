import { ArrowLeft, ChevronRight, Lock, Search, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useLayoutEffect, useRef, useState, type ComponentType, type SyntheticEvent } from 'react'
import { isCapturingBinding } from '@/input/actions'
import { cx } from '@/lib/cx'
import { useGooner } from '@/state/gooner'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useSettingsFeedback } from '@/state/settingsFeedback'
import { useSettingsNavigation } from '@/state/settingsNavigation'
import { AccountSettings } from './AccountSettings'
import { AboutSettings, AdvancedSettings, TelemetrySettings } from './AdvancedSettings'
import { ShortcutsSettings } from './ShortcutsSettings'
import { TrackingSettings } from './TrackingSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { AxesSettings } from './AxesSettings'
import { ChasterSettings } from './ChasterSettings'
import { GoonerSettings } from './GoonerSettings'
import { LibrarySettings, SourcePanel } from './LibrarySettings'
import { PlaybackSettings, SubtitlesSettings } from './PlaybackSettings'
import { RemoteSettings } from './RemoteSettings'
import { SupportSettings } from './SupportSettings'
import { UpscalingSettings } from './UpscalingSettings'
import { ModelPanel } from './ModelPanel'
import { FollowPanel, IntifacePanel } from './ConnectionSettings'
import { DeviceSettings, MediaCentreSettings, SourcesSettings, TechnicalSettings } from './GeneralSettings'
import { categoryFor, PAGE_LABELS, PAGE_TITLES, SETTINGS_CATEGORIES, type SettingsPageId } from './navigation'
import { focusSetting, locateSetting, markSettingRows, searchSettings } from './search'
import './settings.css'

const SIDEBAR_CATEGORIES = SETTINGS_CATEGORIES.map((category) => category.id === 'account' ? { ...category, label: 'settings.page.support' as const, pages: ['support'] as const } : category)

const PAGES: Record<SettingsPageId, ComponentType> = {
  appearance: AppearanceSettings,
  'media-centre': MediaCentreSettings,
  shortcuts: ShortcutsSettings,
  playback: PlaybackSettings,
  video: UpscalingSettings,
  subtitles: SubtitlesSettings,
  gooner: GoonerSettings,
  sources: SourcesSettings,
  tagging: LibrarySettings,
  devices: DeviceSettings,
  axes: AxesSettings,
  estim: () => <AxesSettings estim />,
  tracking: TrackingSettings,
  models: ModelPanel,
  sharing: RemoteSettings,
  source: SourcePanel,
  headsets: FollowPanel,
  intiface: IntifacePanel,
  chaster: ChasterSettings,
  profile: AccountSettings,
  friends: () => <AccountSettings page="friends" />,
  privacy: () => <AccountSettings page="privacy" />,
  support: SupportSettings,
  technical: TechnicalSettings,
  maintenance: AdvancedSettings,
  telemetry: TelemetrySettings,
  about: AboutSettings,
}

export function SettingsScreen() {
  const t = useT()
  const nav = useSettingsNavigation()
  const errors = useSettingsFeedback((s) => s.errors)
  const loaded = useSettings((s) => s.settings !== null)
  const locked = useGooner((s) => s.locked)
  const page = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(0)
  const mobilePage = nav.showPage
  const setMobilePage = (showPage: boolean) => useSettingsNavigation.setState({ showPage })
  const category = categoryFor(nav.page)
  const Page = PAGES[nav.page]
  const results = searchSettings(nav.query)
  useLayoutEffect(() => {
    const element = page.current
    if (!element || nav.results || !loaded) return
    markSettingRows(element)
    element.scrollTop = useSettingsNavigation.getState().scroll[nav.page] ?? 0
    if (nav.target) {
      focusSetting(element, nav.target)
      useSettingsNavigation.setState({ target: null })
    }
    return () => {
      useSettingsNavigation.getState().setScroll(nav.page, element.scrollTop)
    }
  }, [nav.page, nav.results, nav.revision, loaded])
  useLayoutEffect(() => {
    if (page.current) markSettingRows(page.current)
  })
  useLayoutEffect(() => {
    if (nav.results) document.getElementById(`settings-result-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, nav.results])
  const captureEdit = (event: SyntheticEvent) => {
    if (!(event.target instanceof HTMLElement)) return
    const target = event.target.closest<HTMLElement>('[data-setting]')?.dataset.setting ?? 'page'
    const edit = { page: nav.page, target }
    useSettingsFeedback.setState({ current: edit })
    queueMicrotask(() => {
      if (useSettingsFeedback.getState().current === edit) useSettingsFeedback.setState({ current: null })
    })
  }
  const choose = (id: SettingsPageId) => {
    nav.selectPage(id, 'page')
    setMobilePage(true)
  }
  return (
    <div
      className={cx('settings-layout', mobilePage && 'settings-show-page', nav.results && 'settings-searching')}
      onKeyDown={(event) => {
        if (!isCapturingBinding() && event.key !== ' ') event.stopPropagation()
      }}
    >
      <aside className="settings-sidebar">
        <h1>{t('settings.screen.title')}</h1>
        <div className="settings-search">
          <Search aria-hidden="true" />
          <input
            ref={search}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={nav.results}
            aria-label={t('settings.search.title')}
            placeholder={t('settings.search.title')}
            value={nav.query}
            onChange={(e) => {
              nav.setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                e.stopPropagation()
                setActive((i) => Math.max(0, Math.min(results.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
              }
              if (e.key === 'Enter' && results[active]) {
                e.preventDefault()
                nav.reveal(results[active])
                setMobilePage(true)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                nav.setQuery('')
              }
            }}
            aria-controls={nav.results ? 'settings-results' : undefined}
            aria-activedescendant={nav.results && results[active] ? `settings-result-${active}` : undefined}
          />
          {nav.query && (
            <button
              type="button"
              aria-label={t('settings.search.clear')}
              onClick={() => {
                nav.setQuery('')
                search.current?.focus()
              }}
            >
              <X />
            </button>
          )}
        </div>
        <nav aria-label={t('settings.screen.title')}>
          {SIDEBAR_CATEGORIES.map((c) => (
            <div className={cx('settings-category', c.id === 'about' && 'settings-about')} key={c.id}>
              <button
                type="button"
                className={cx('settings-category-button', category.id === c.id && 'on')}
                aria-expanded={c.id === 'about' ? undefined : category.id === c.id}
                aria-current={c.id === 'about' && nav.page === 'about' ? 'page' : undefined}
                onClick={() => {
                  nav.selectPage(c.id === 'account' ? 'support' : nav.lastPages[c.id] ?? c.pages[0], 'page')
                  setMobilePage(true)
                }}
              >
                <c.icon />
                <span>{t(c.label)}</span>
                <ChevronRight className="settings-category-chevron" />
              </button>
              {category.id === c.id && c.id !== 'about' && (
                <ul>
                  {c.pages.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        className={cx('settings-page-button', nav.page === id && 'on')}
                        aria-current={nav.page === id ? 'page' : undefined}
                        onClick={() => choose(id)}
                      >
                        <span>{t(PAGE_LABELS[id])}</span>
                        {id === 'gooner' && locked && <Lock aria-label={t('settings.screen.locked')} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </nav>
      </aside>
      <section
        ref={page}
        className="page set-page"
        onClickCapture={captureEdit}
        onChangeCapture={captureEdit}
        onBlurCapture={captureEdit}
        onFocusCapture={captureEdit}
        onPointerDownCapture={captureEdit}
        onPointerMoveCapture={(event) => {
          if (event.buttons) captureEdit(event)
        }}
        onPointerUpCapture={captureEdit}
        onKeyDownCapture={captureEdit}
        key={nav.results ? 'results' : nav.page}
        aria-label={nav.results ? t('settings.search.title') : t(PAGE_LABELS[nav.page])}
      >
        <button type="button" className="settings-mobile-back" onClick={() => setMobilePage(false)}>
          <ArrowLeft /> {t('settings.screen.title')}
        </button>
        {nav.results ? (
          <>
            <div className="page-hd">
              <h1 tabIndex={-1}>{t('settings.search.title')}</h1>
            </div>
            {results.length === 0 ? (
              <p className="sub" role="status">
                {t('settings.search.noResults')}
              </p>
            ) : (
              <ul className="settings-results" id="settings-results" role="listbox" aria-label={t('settings.search.results')}>
                {results.map((result, i) => (
                  <li key={`${result.page}:${result.id}`}>
                    <button
                      type="button"
                      id={`settings-result-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={cx(i === active && 'on')}
                      onFocus={() => setActive(i)}
                      onClick={() => {
                        nav.reveal(result)
                        setMobilePage(true)
                      }}
                    >
                      <span>
                        {result.label}
                        <span className="sub">
                          {t(categoryFor(result.page).label)} › {t(PAGE_LABELS[result.page])}
                          {result.advanced ? ` › ${t('settings.screen.advanced')}` : ''}
                        </span>
                      </span>
                      <ChevronRight />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            {(nav.query || nav.history.length > 0) && (
              <button
                type="button"
                className="settings-back"
                onClick={() => {
                  nav.back()
                  if (nav.query && nav.history.length === 0) requestAnimationFrame(() => document.getElementById(`settings-result-${active}`)?.focus())
                }}
              >
                <ArrowLeft />
                {nav.query && nav.history.length === 0 ? t('settings.search.results') : t('common.back')}
              </button>
            )}
            <div className="page-hd">
              <h1 tabIndex={-1}>{t(PAGE_TITLES[nav.page] ?? PAGE_LABELS[nav.page])}</h1>
            </div>
            {loaded ? (
              <Page />
            ) : (
              <p className="sub" role="status">
                {t('settings.screen.loading')}
              </p>
            )}
            {Object.entries(errors)
              .filter(([, value]) => value.edit.page === nav.page)
              .map(([key, { edit, message }]) => {
                const row = page.current ? locateSetting(page.current, edit.target) : null
                const error = (
                  <span className="settings-save-error" role="alert">
                    {t('settings.screen.saveFailed', { message })}
                  </span>
                )
                return row && row.tagName !== 'H1' ? createPortal(error, row, key) : <div key={key}>{error}</div>
              })}
          </>
        )}
      </section>
    </div>
  )
}

import { ArrowRight, Globe, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useBrowser } from '@/state/browser'
import { useT } from '@/state/i18n'
import './StartPage.css'

export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function SiteIcon({ url, icon, size = 16 }: { url: string; icon?: string | null; size?: number }) {
  const icons = useBrowser((state) => state.startData?.icons)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  let source: string | null = icon ?? null
  if (!source) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        source = icons?.[parsed.hostname] ?? `${parsed.origin}/favicon.ico`
      }
    } catch {
    }
  }
  return source && source !== failedSource ? (
    <img
      className="bstart-site-icon"
      src={source}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailedSource(source)}
    />
  ) : <Globe className="bstart-site-icon" size={size} aria-hidden="true" />
}

export function StartPage() {
  const t = useT()
  const mostVisited = useBrowser((state) => state.startData?.mostVisited)
  const navigate = useBrowser((state) => state.navigate)
  const [query, setQuery] = useState('')

  const search = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) return
    const url = new URL('https://www.bing.com/videos/search')
    url.searchParams.set('q', text)
    url.searchParams.set('adlt', 'off')
    void navigate(url.href)
  }

  return (
    <section className="bstart" aria-label={t('browser.tab.new')}>
      <div className="bstart-centre">
        <form className="bstart-search" role="search" onSubmit={search}>
          <Search size={21} aria-hidden="true" />
          <input
            aria-label={t('browser.start.search')}
            placeholder={t('browser.start.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" aria-label={t('browser.start.go')} disabled={!query.trim()}>
            <ArrowRight size={21} aria-hidden="true" />
          </button>
        </form>
      </div>
      {!!mostVisited?.length && (
        <nav className="bstart-visits" aria-label={t('browser.start.mostVisited')}>
          <div className="bstart-visit-row">
            {mostVisited.slice(0, 10).map((site) => (
              <button
                key={site.url}
                type="button"
                className="bstart-visit"
                title={site.url}
                onClick={() => void navigate(site.url)}
              >
                <SiteIcon url={site.url} size={32} />
                <span>{siteName(site.url)}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </section>
  )
}
